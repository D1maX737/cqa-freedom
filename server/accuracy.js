// Точность модели против ручной разметки. Чистые функции: данные приходят готовыми.
// Сравнивается исходный ответ модели, до апелляций: апелляции — это уже работа человека.
import { round2, computeTotal } from './scoring.js';
import { answersFrom } from './results.js';

/**
 * Эталон по каждому критерию из разметок одного диалога.
 * Если люди ответили по-разному или сами отметили «спорно», ячейка спорная:
 * в общем счёте засчитывается любой из ответов людей, в счёте «без спорных» не участвует.
 */
export function consensus(entries, checklist) {
  const result = {};
  for (const criterion of checklist.criteria) {
    const given = entries.map((e) => e.criteria?.[criterion.id]).filter((item) => item?.value !== undefined && item.value !== null);
    if (!given.length) continue;
    const values = [...new Set(given.map((item) => String(item.value)))];
    result[criterion.id] = { values, disputed: values.length > 1 || given.some((item) => item.disputed === true), labelers: given.length };
  }
  return result;
}

const bucket = () => ({ cells: 0, matched: 0, rate: null });
function add(target, matched) {
  target.cells += 1;
  if (matched) target.matched += 1;
  target.rate = target.matched / target.cells;
}

function cohenKappa(pairs) {
  if (!pairs.length) return null;
  const n = pairs.length;
  const count = (side) => pairs.reduce((map, pair) => map.set(pair[side], (map.get(pair[side]) ?? 0) + 1), new Map());
  const human = count(0);
  const model = count(1);
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  let expected = 0;
  for (const [value, k] of human) expected += (k / n) * ((model.get(value) ?? 0) / n);
  if (expected === 1) return observed === 1 ? 1 : 0;
  return round2((observed - expected) / (1 - expected));
}

/** Согласие людей между собой там, где диалог разметили двое и больше. */
function agreementOf(byConversation, checklist) {
  const agreement = { cells: 0, matched: 0, conversations: 0 };
  for (const entries of byConversation.values()) {
    const labelers = new Set(entries.map((e) => e.labeler));
    if (labelers.size < 2) continue;
    agreement.conversations += 1;
    for (const criterion of checklist.criteria) {
      const values = entries.map((e) => e.criteria?.[criterion.id]?.value).filter((v) => v !== undefined && v !== null).map(String);
      if (values.length < 2) continue;
      agreement.cells += 1;
      if (new Set(values).size === 1) agreement.matched += 1;
    }
  }
  return agreement;
}

/**
 * @param checklist версия чек-листа, по которой оценивала модель
 * @param conversations [{conversation_id, language}] набора
 * @param labels плоский список разметок (readLabels)
 * @param modelAnswers {conversation_id: {criterion_id: answer}} — исходные ответы модели
 * @param tuningIds диалоги, на которых настраивали промпт: считаются отдельно от остальных
 */
export function computeAccuracy({ checklist, conversations, labels, modelAnswers, tuningIds = [] }) {
  const ids = new Set(conversations.map((c) => c.conversation_id));
  const byConversation = new Map();
  for (const entry of labels.filter((l) => ids.has(l.conversation_id))) {
    byConversation.set(entry.conversation_id, [...(byConversation.get(entry.conversation_id) ?? []), entry]);
  }
  const tuning = new Set(tuningIds);

  const overall = bucket();
  const clear = bucket();
  const byCriterion = new Map(checklist.criteria.map((c) => [c.id, { id: c.id, title: c.title, ...bucket() }]));
  const byLanguage = new Map();
  const bySplit = { tuning: bucket(), holdout: bucket() };
  const gross = { human: 0, found: 0, missed: 0, false_alarms: 0 };
  const mismatches = [];
  const deviations = [];
  const pairs = [];
  let compared = 0;

  for (const conversation of conversations) {
    const id = conversation.conversation_id;
    const model = modelAnswers[id];
    const entries = byConversation.get(id);
    if (!model || !entries) continue;
    compared += 1;
    const gold = consensus(entries, checklist);
    const language = byLanguage.get(conversation.language) ?? { language: conversation.language, ...bucket() };
    byLanguage.set(conversation.language, language);

    for (const criterion of checklist.criteria) {
      const cell = gold[criterion.id];
      if (!cell) continue;
      const answer = model[criterion.id] === undefined || model[criterion.id] === null ? null : String(model[criterion.id]);
      const matched = answer !== null && cell.values.includes(answer);
      for (const target of [overall, byCriterion.get(criterion.id), language, bySplit[tuning.has(id) ? 'tuning' : 'holdout']]) add(target, matched);
      if (!cell.disputed) add(clear, matched);
      pairs.push([matched ? answer : cell.values[0], answer ?? '—']);
      if (!matched) mismatches.push({ conversation_id: id, criterion_id: criterion.id, human: cell.values, model: answer, disputed: cell.disputed });
      if (criterion.type === 'flag') {
        const humanYes = cell.values.includes('yes');
        const modelYes = answer === 'yes';
        if (humanYes) gross.human += 1;
        if (humanYes && modelYes) gross.found += 1;
        if (humanYes && !modelYes) gross.missed += 1;
        if (!humanYes && modelYes) gross.false_alarms += 1;
      }
    }

    const humanAnswers = Object.fromEntries(Object.entries(gold).map(([criterionId, cell]) => [criterionId, cell.values[0]]));
    const humanTotal = computeTotal(checklist, humanAnswers);
    const modelTotal = computeTotal(checklist, model);
    if (humanTotal !== null && modelTotal !== null) deviations.push(Math.abs(modelTotal - humanTotal));
  }

  const mean = deviations.length ? round2(deviations.reduce((a, b) => a + b, 0) / deviations.length) : null;
  return {
    coverage: {
      conversations: conversations.length,
      labeled: byConversation.size,
      evaluated: conversations.filter((c) => modelAnswers[c.conversation_id]).length,
      compared,
    },
    overall,
    clear,
    kappa: cohenKappa(pairs),
    by_criterion: [...byCriterion.values()].filter((c) => c.cells > 0),
    by_language: [...byLanguage.values()].filter((l) => l.cells > 0),
    by_split: bySplit,
    gross,
    total_deviation: { mean, max: deviations.length ? round2(Math.max(...deviations)) : null, conversations: deviations.length },
    agreement: agreementOf(byConversation, checklist),
    mismatches,
  };
}

/**
 * Точность по базе: последняя завершённая оценка каждого диалога этой версией чек-листа.
 * Оценки заглушкой — не модель: без allowMock они не в счёт.
 */
export function collectAccuracy(db, { versionId, groupId, labels, tuningIds = [], allowMock = false }) {
  const version = versionId ? db.checklists.get(versionId) : db.checklists.latest();
  if (!version) throw new Error(`Версия чек-листа ${versionId} не найдена`);
  const conversations = db.conversations.list(groupId || undefined);
  const modelAnswers = {};
  const models = new Set();
  let mockSkipped = 0;
  for (const conversation of conversations) {
    const done = db.evaluations.listFor(conversation.conversation_id)
      .filter((e) => e.checklist_version_id === version.id && e.status === 'done' && e.result);
    const evaluation = done.find((e) => allowMock || e.provider !== 'mock');
    if (!evaluation) {
      if (done.length) mockSkipped += 1;
      continue;
    }
    modelAnswers[conversation.conversation_id] = answersFrom(evaluation.result, version.config);
    models.add(evaluation.model);
  }
  const report = computeAccuracy({ checklist: version.config, conversations, labels, modelAnswers, tuningIds });
  return { checklist_version_id: version.id, checklist: version.config, models: [...models], mock_skipped: mockSkipped, ...report };
}
