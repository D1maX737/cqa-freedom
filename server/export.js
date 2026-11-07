// Выгрузка в results.json по формату организаторов (приложение к гайду, «Формат JSON 1.0»).
// Коды критериев и типы значений берутся из конфига версии чек-листа.
import { allowedAnswers } from './checklist.js';
import { answersFrom, applyDecisions } from './results.js';
import { computeAll } from './scoring.js';

export const SCHEMA_VERSION = '1.0';
const MODES = new Set(['local', 'external_api', 'hybrid']);
// mock работает без сети; в настоящую выгрузку он не попадает без --allow-mock.
const LOCAL_PROVIDERS = new Set(['ollama', 'mock']);

/** «Да» → true, «Нет» → false, N/A → null, шкала → число до учёта веса. */
export function exportValue(criterion, answer) {
  if (answer === 'na') return null;
  if (criterion.type === 'scale') return Number(answer);
  return answer === 'yes';
}

/** Обратное преобразование, чтобы пересчитать итог по значениям из файла. */
function answerFromValue(criterion, value) {
  if (value === null) return 'na';
  if (criterion.type === 'scale') return String(value);
  return value ? 'yes' : 'no';
}

const allowedValues = (criterion) => (criterion.type === 'flag'
  ? [true, false]
  : allowedAnswers(criterion).map((answer) => exportValue(criterion, answer)));

/** Номера реплик с 1 по исходному массиву транскрипта: m0 — первая реплика. */
export function turnsFor(ids) {
  const turns = new Set();
  for (const id of ids) {
    const match = /^m(\d+)$/.exec(id);
    if (match) turns.add(Number(match[1]) + 1);
  }
  return [...turns].sort((a, b) => a - b);
}

/** Критерии версии без кода выгрузки: такую версию нельзя выгрузить в формат организаторов. */
export function exportProblems(checklist) {
  return checklist.criteria.filter((c) => !c.code).map((c) => `${c.id}: нет кода для results.json — задайте его в редакторе чек-листа`);
}

const errorRecord = (conversationId, error) => ({ conversation_id: conversationId, status: 'error', criteria: [], score: null, error });

function lastDecision(appeals, criterionId) {
  return appeals
    .filter((a) => a.criterion_id === criterionId && a.status === 'decided' && a.action === 'change')
    .sort((a, b) => a.decided_at.localeCompare(b.decided_at))
    .at(-1);
}

export function buildRecord({ conversation, evaluation, checklist, appeals = [], useFinal = true }) {
  const id = conversation.conversation_id;
  if (!evaluation) return errorRecord(id, 'Диалог не оценён');
  if (evaluation.status !== 'done' || !evaluation.result) {
    return errorRecord(id, evaluation.error || `Оценка не завершена: ${evaluation.status}`);
  }

  const { result } = evaluation;
  const decisions = useFinal ? appeals : [];
  const answers = applyDecisions(answersFrom(result, checklist), decisions);
  const missing = checklist.criteria.filter((c) => c.type !== 'flag' && !allowedAnswers(c).includes(String(answers[c.id])));
  if (missing.length) return errorRecord(id, `Модель не вернула оценку по критериям: ${missing.map((c) => c.id).join(', ')}`);

  const operatorIds = conversation.transcript.map((turn, index) => (turn.speaker === 'operator' ? `m${index}` : null)).filter(Boolean);
  const criteria = checklist.criteria.map((criterion) => {
    const decision = lastDecision(decisions, criterion.id);
    const value = exportValue(criterion, answers[criterion.id]);
    if (criterion.type === 'flag') {
      const gross = result.gross_errors.filter((g) => g.criterion_id === criterion.id);
      const found = gross.map((g) => g.explanation).filter(Boolean).join(' ') || 'Найдено грубое нарушение.';
      return {
        criterion_id: criterion.code,
        value,
        rationale: decision ? `Решение проверяющего: ${decision.reason}` : (gross.length ? found : 'Грубых нарушений в репликах оператора не найдено.'),
        evidence_turns: turnsFor(value && gross.length ? gross.map((g) => g.msg_id) : operatorIds),
      };
    }
    const item = result.criteria.find((c) => c.id === criterion.id) ?? {};
    const own = answers[criterion.id] === 'na' ? (item.na_reason || item.explanation) : item.explanation;
    return {
      criterion_id: criterion.code,
      value,
      rationale: decision ? `Решение проверяющего: ${decision.reason}` : (own ?? '').trim(),
      evidence_turns: turnsFor([...(item.evidence ?? []).map((e) => e.msg_id), ...(item.expected_at ?? [])]),
    };
  });

  const flags = checklist.criteria.filter((c) => c.type === 'flag');
  return {
    conversation_id: id,
    status: 'ok',
    criteria,
    score: {
      final_score: computeAll(checklist, answers).total,
      critical_flag: flags.some((c) => answers[c.id] === 'yes'),
    },
  };
}

/** mode и name по фактически использованным моделям. */
export function modelInfo(evaluations) {
  const names = [...new Set(evaluations.map((e) => e.model).filter(Boolean))];
  const local = evaluations.map((e) => LOCAL_PROVIDERS.has(e.provider));
  const mode = local.every(Boolean) ? 'local' : local.some(Boolean) ? 'hybrid' : 'external_api';
  return { mode, name: names.join(', ') };
}

export function buildResultsFile({ teamName, model, records }) {
  return { schema_version: SCHEMA_VERSION, team_name: teamName, model, results: records };
}

function validateRecord(record, checklist, transcriptLength) {
  const errors = [];
  const id = record.conversation_id;
  const push = (message) => errors.push(`${id}: ${message}`);

  if (record.status === 'error') {
    if (!Array.isArray(record.criteria) || record.criteria.length) push('у записи с ошибкой criteria должен быть пустым');
    if (record.score !== null) push('у записи с ошибкой score должен быть null');
    if (!record.error?.trim?.()) push('у записи с ошибкой нужна причина в error');
    return errors;
  }
  if (record.status !== 'ok') return [`${id}: status «${record.status}», допустимо ok или error`];

  const items = Array.isArray(record.criteria) ? record.criteria : [];
  const byCode = new Map(checklist.criteria.map((c) => [c.code, c]));
  for (const item of items) if (!byCode.has(item.criterion_id)) push(`неизвестный критерий ${item.criterion_id}`);

  let valuesValid = true;
  const answers = {};
  for (const [code, criterion] of byCode) {
    const found = items.filter((item) => item.criterion_id === code);
    if (found.length !== 1) {
      push(found.length ? `критерий ${code} встречается ${found.length} раза` : `нет критерия ${code}`);
      valuesValid = false;
    }
    const [item] = found;
    if (!item) continue;
    if (!allowedValues(criterion).some((v) => v === item.value)) {
      push(`${code} = ${JSON.stringify(item.value)}, допустимо: ${allowedValues(criterion).map((v) => JSON.stringify(v)).join(', ')}`);
      valuesValid = false;
    } else {
      answers[criterion.id] = answerFromValue(criterion, item.value);
    }
    if (typeof item.rationale !== 'string') push(`${code}: rationale должен быть строкой`);
    const turns = Array.isArray(item.evidence_turns) ? item.evidence_turns : null;
    if (!turns) push(`${code}: evidence_turns должен быть массивом`);
    const outside = (turns ?? []).filter((t) => !Number.isInteger(t) || t < 1 || t > transcriptLength);
    if (outside.length) push(`${code}: номера реплик вне диалога: ${outside.join(', ')}`);
  }

  const score = record.score ?? {};
  if (typeof score.final_score !== 'number' || score.final_score < 0 || score.final_score > 100
    || Math.round(score.final_score * 100) / 100 !== score.final_score) {
    push(`final_score ${JSON.stringify(score.final_score)} должен быть числом от 0 до 100 с двумя знаками`);
  } else if (valuesValid) {
    const total = computeAll(checklist, answers).total;
    if (total !== score.final_score) push(`final_score ${score.final_score} не совпадает с пересчётом по значениям: ${total}`);
  }
  const flags = checklist.criteria.filter((c) => c.type === 'flag');
  const critical = flags.some((c) => items.find((item) => item.criterion_id === c.code)?.value === true);
  if (score.critical_flag !== critical) push('critical_flag не совпадает со значением критерия critical');
  return errors;
}

/** Все нарушения формата; пустой массив — файл можно отправлять. */
export function validateResultsFile(file, checklist, conversations) {
  const errors = [];
  if (file?.schema_version !== SCHEMA_VERSION) errors.push(`schema_version должен быть «${SCHEMA_VERSION}»`);
  if (!file?.team_name?.trim?.()) errors.push('не указан team_name');
  if (!MODES.has(file?.model?.mode)) errors.push(`model.mode «${file?.model?.mode}», допустимо: ${[...MODES].join(', ')}`);
  if (!file?.model?.name?.trim?.()) errors.push('не указан model.name');
  const results = Array.isArray(file?.results) ? file.results : [];
  if (!Array.isArray(file?.results)) errors.push('results должен быть массивом');

  const lengths = new Map(conversations.map((c) => [c.conversation_id, c.transcript.length]));
  const counts = new Map();
  for (const record of results) counts.set(record.conversation_id, (counts.get(record.conversation_id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) errors.push(`${id}: повторяется ${count} раза`);
    if (!lengths.has(id)) errors.push(`${id}: такого диалога нет в наборе`);
  }
  for (const id of lengths.keys()) if (!counts.has(id)) errors.push(`${id}: нет в файле`);

  const seen = new Set();
  for (const record of results) {
    if (seen.has(record.conversation_id)) continue;
    seen.add(record.conversation_id);
    errors.push(...validateRecord(record, checklist, lengths.get(record.conversation_id) ?? 0));
  }
  return errors;
}

/**
 * Собирает results.json по набору из БД: последняя завершённая оценка каждого диалога этой версией чек-листа.
 * Диалоги без оценки попадают в файл со status = "error" — организаторы требуют не скрывать их.
 */
export function collectResults(db, { groupId, versionId, teamName, useFinal = true, allowMock = false, fallbackModel = null }) {
  const version = db.checklists.get(versionId);
  if (!version) throw new Error(`Версия чек-листа ${versionId} не найдена`);
  const checklist = version.config;
  const problems = exportProblems(checklist);
  if (problems.length) throw new Error(`Версию ${version.id} нельзя выгрузить:\n${problems.join('\n')}`);
  if (!teamName?.trim()) throw new Error('Укажите название команды: --team "…" или TEAM_NAME в .env');
  const conversations = db.conversations.list(groupId);
  if (!conversations.length) throw new Error(`В базе нет диалогов набора ${groupId}: сначала npm run fetch -- ${groupId}`);

  const used = [];
  let withDecisions = 0;
  const records = conversations.map((conversation) => {
    const evaluations = db.evaluations.listFor(conversation.conversation_id).filter((e) => e.checklist_version_id === version.id);
    const evaluation = evaluations.find((e) => e.status === 'done') ?? evaluations[0] ?? null;
    if (evaluation?.status === 'done') used.push(evaluation);
    const appeals = evaluation ? db.appeals.forEvaluation(evaluation.id) : [];
    if (useFinal && appeals.some((a) => a.status === 'decided' && a.action === 'change')) withDecisions += 1;
    return buildRecord({ conversation, evaluation, checklist, appeals, useFinal });
  });

  const mock = used.filter((e) => e.provider === 'mock').length;
  if (mock && !allowMock) {
    throw new Error(`${mock} оценок сделаны заглушкой mock, а не моделью. Оцените заново с настоящей моделью (npm run batch -- ${groupId} --force)`);
  }
  // Если ни один диалог не оценён, файл всё равно сдаётся: модель берётся из настроек.
  const model = used.length || !fallbackModel ? modelInfo(used) : fallbackModel;
  const file = buildResultsFile({ teamName: teamName.trim(), model, records });
  const failed = records.filter((r) => r.status === 'error');
  return {
    file,
    errors: validateResultsFile(file, checklist, conversations),
    summary: { versionId: version.id, total: records.length, ok: records.length - failed.length, failed, withDecisions },
  };
}
