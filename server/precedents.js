// Обучение на апелляциях: решение проверяющего, изменившее оценку, становится прецедентом —
// примером толкования правила для следующих оценок других диалогов.
import { answersFrom } from './results.js';

const TEXT_LIMIT = 220;
const FRAGMENT_LIMIT = 2;

/** Старое решение толкует то же правило, только если у критерия не менялись тип, шкала, определение и условие N/A. */
export function sameRule(a, b) {
  if (!a || !b) return false;
  return a.type === b.type
    && a.definition === b.definition
    && (a.na_condition ?? '') === (b.na_condition ?? '')
    && JSON.stringify(a.scale ?? null) === JSON.stringify(b.scale ?? null);
}

function fragmentOf(conversation, ids) {
  return [...new Set(ids)].slice(0, FRAGMENT_LIMIT).flatMap((id) => {
    const turn = conversation?.transcript[Number(id.slice(1))];
    if (!turn) return [];
    const text = turn.text.length > TEXT_LIMIT ? `${turn.text.slice(0, TEXT_LIMIT)}…` : turn.text;
    return [{ id, speaker: turn.speaker, text }];
  });
}

/**
 * Свежие решения «Изменить» по другим диалогам для критериев текущей версии чек-листа.
 * В тот же диалог прецедент не подставляется: иначе модель просто повторит решение по нему.
 */
export function collectPrecedents(db, { checklist, conversationId, maxPerCriterion = 2, maxTotal = 8 }) {
  // Новые решения первыми; при равном времени — позже созданные.
  const decided = [...db.appeals.list('decided')].reverse()
    .filter((a) => a.action === 'change')
    .sort((a, b) => b.decided_at.localeCompare(a.decided_at));
  const precedents = [];
  const perCriterion = new Map();
  const seen = new Set();
  for (const appeal of decided) {
    if (precedents.length >= maxTotal) break;
    const key = `${appeal.evaluation_id}:${appeal.criterion_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const criterion = checklist.criteria.find((c) => c.id === appeal.criterion_id);
    if (!criterion || (perCriterion.get(criterion.id) ?? 0) >= maxPerCriterion) continue;
    const evaluation = db.evaluations.get(appeal.evaluation_id);
    if (!evaluation?.result || evaluation.conversation_id === conversationId) continue;
    const source = db.checklists.get(evaluation.checklist_version_id)?.config;
    if (!sameRule(criterion, source?.criteria.find((c) => c.id === criterion.id))) continue;

    const item = evaluation.result.criteria.find((c) => c.id === criterion.id);
    const ids = criterion.type === 'flag'
      ? evaluation.result.gross_errors.filter((g) => g.criterion_id === criterion.id).map((g) => g.msg_id)
      : [...(item?.evidence ?? []).map((e) => e.msg_id), ...(item?.expected_at ?? [])];
    precedents.push({
      appeal_id: appeal.id,
      conversation_id: evaluation.conversation_id,
      criterion_id: criterion.id,
      criterion_title: criterion.title,
      original: answersFrom(evaluation.result, source)[criterion.id] ?? null,
      decided: appeal.new_value,
      reason: appeal.reason,
      fragment: fragmentOf(db.conversations.get(evaluation.conversation_id), ids),
    });
    perCriterion.set(criterion.id, (perCriterion.get(criterion.id) ?? 0) + 1);
  }
  return precedents;
}
