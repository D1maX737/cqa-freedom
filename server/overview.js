// Сводка по набору для руководителя: считается по финальным оценкам (с решениями проверяющего), без ИИ.
import { round2 } from './scoring.js';
import { buildEvaluationView } from './results.js';
import { latestEvaluatedVersion } from './versions.js';

const BUCKETS = [
  { label: '100', test: (t) => t === 100 },
  { label: '85–99', test: (t) => t >= 85 && t < 100 },
  { label: '70–84', test: (t) => t >= 70 && t < 85 },
  { label: '50–69', test: (t) => t >= 50 && t < 70 },
  { label: 'ниже 50', test: (t) => t < 50 },
];

const mean = (values) => (values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null);

function isGross(view, checklist) {
  return checklist.criteria.some((c) => c.type === 'flag' && view.final.answers[c.id] === 'yes');
}

/**
 * @param entries [{conversation: {conversation_id, language, channel, transcript}, view}] — view из buildEvaluationView
 */
export function computeOverview({ checklist, entries }) {
  const scored = entries.filter((e) => e.view.final?.scores.total !== null && e.view.final?.scores.total !== undefined);
  const totals = scored.map((e) => e.view.final.scores.total);

  // Сколько баллов из 100 критерий отнимает в среднем: вес после перераспределения минус набранное.
  const losses = checklist.criteria.filter((c) => c.type !== 'flag' && c.weight > 0).map((criterion) => {
    let lostSum = 0;
    let failed = 0;
    let applicable = 0;
    let worst = null;
    for (const { conversation, view } of scored) {
      const cell = view.final.scores.criteria[criterion.id];
      if (!cell || cell.effective_weight === null) continue;
      applicable += 1;
      const lost = cell.effective_weight - cell.effective_score;
      if (lost <= 0.001) continue;
      failed += 1;
      lostSum += lost;
      if (!worst || lost > worst.lost) worst = { lost, conversation, view };
    }
    let example = null;
    if (worst) {
      const item = worst.view.criteria.find((c) => c.id === criterion.id);
      const msgId = item?.expected_at[0] ?? item?.evidence[0]?.msg_id ?? null;
      example = {
        conversation_id: worst.conversation.conversation_id,
        msg_id: msgId,
        text: msgId ? worst.conversation.transcript[Number(msgId.slice(1))]?.text ?? null : null,
        explanation: item?.explanation ?? null,
      };
    }
    return { id: criterion.id, title: criterion.title, average_lost: scored.length ? round2(lostSum / scored.length) : 0, failed, applicable, example };
  }).filter((l) => l.average_lost > 0).sort((a, b) => b.average_lost - a.average_lost);

  const gross = entries.filter((e) => isGross(e.view, checklist)).map(({ conversation, view }) => {
    const first = view.gross_errors[0];
    return { conversation_id: conversation.conversation_id, msg_id: first?.msg_id ?? null, explanation: first?.explanation ?? null };
  });

  const languages = [...new Set(entries.map((e) => e.conversation.language))];
  return {
    dialogs: entries.length,
    average: mean(totals),
    perfect: totals.filter((t) => t === 100).length,
    below70: totals.filter((t) => t < 70).length,
    needs_review: entries.filter((e) => e.view.needs_review).length,
    distribution: BUCKETS.map((b) => ({ label: b.label, count: totals.filter(b.test).length })),
    losses,
    gross,
    by_language: languages.map((language) => {
      const own = entries.filter((e) => e.conversation.language === language);
      return {
        language,
        dialogs: own.length,
        average: mean(own.map((e) => e.view.final?.scores.total).filter((t) => t !== null && t !== undefined)),
        gross: own.filter((e) => isGross(e.view, checklist)).length,
      };
    }),
    worst: [...scored].sort((a, b) => a.view.final.scores.total - b.view.final.scores.total).slice(0, 5).map(({ conversation, view }) => ({
      conversation_id: conversation.conversation_id,
      language: conversation.language,
      channel: conversation.channel,
      total: view.final.scores.total,
      gross: isGross(view, checklist),
    })),
  };
}

/** Сводка по базе: последняя завершённая оценка каждого диалога версией; заглушка не в счёт без allowMock. */
export function collectOverview(db, { versionId, groupId, allowMock = false }) {
  const version = versionId ? db.checklists.get(versionId) : latestEvaluatedVersion(db, groupId);
  if (!version) throw new Error(`Версия чек-листа ${versionId} не найдена`);
  const entries = [];
  const models = new Set();
  let mockSkipped = 0;
  const conversations = db.conversations.list(groupId || undefined);
  for (const conversation of conversations) {
    const done = db.evaluations.listFor(conversation.conversation_id)
      .filter((e) => e.checklist_version_id === version.id && e.status === 'done' && e.result);
    const evaluation = done.find((e) => allowMock || e.provider !== 'mock');
    if (!evaluation) {
      if (done.length) mockSkipped += 1;
      continue;
    }
    models.add(evaluation.model);
    entries.push({ conversation, view: buildEvaluationView(evaluation, version, db.appeals.forEvaluation(evaluation.id)) });
  }
  return {
    group_id: groupId || null,
    checklist_version_id: version.id,
    conversations: conversations.length,
    models: [...models],
    mock_skipped: mockSkipped,
    open_appeals: db.appeals.list('open').length,
    ...computeOverview({ checklist: version.config, entries }),
  };
}
