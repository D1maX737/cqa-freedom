import { allowedAnswers } from './checklist.js';
import { computeAll } from './scoring.js';

export function answersFrom(result, checklist) {
  const answers = Object.fromEntries(result.criteria.map((c) => [c.id, c.answer]));
  for (const criterion of checklist.criteria.filter((c) => c.type === 'flag')) {
    answers[criterion.id] = result.gross_errors.some((g) => g.criterion_id === criterion.id) ? 'yes' : 'no';
  }
  return answers;
}

/** Что проверяющий может поставить вместо исходного ответа. */
export const decisionValues = (criterion) => (criterion.type === 'flag' ? ['yes', 'no'] : allowedAnswers(criterion));

export function applyDecisions(answers, appeals) {
  const final = { ...answers };
  const decided = appeals.filter((a) => a.status === 'decided' && a.action === 'change')
    .sort((a, b) => a.decided_at.localeCompare(b.decided_at));
  for (const appeal of decided) final[appeal.criterion_id] = appeal.new_value;
  return final;
}

const pick = (scores, id) => {
  const c = scores.criteria[id];
  return c && { answer: c.answer, score: c.score, effective_weight: c.effective_weight, effective_score: c.effective_score, pending: c.pending, applicable: c.applicable };
};

export function buildEvaluationView(evaluation, checklistVersion, appeals) {
  const checklist = checklistVersion.config;
  const base = {
    id: evaluation.id,
    conversation_id: evaluation.conversation_id,
    checklist_version_id: evaluation.checklist_version_id,
    checklist_name: checklistVersion.name,
    status: evaluation.status,
    provider: evaluation.provider,
    model: evaluation.model,
    attempts: evaluation.attempts,
    needs_review: evaluation.needs_review,
    input_tokens: evaluation.input_tokens,
    output_tokens: evaluation.output_tokens,
    cost_usd: evaluation.cost_usd,
    error: evaluation.error,
    created_at: evaluation.created_at,
    finished_at: evaluation.finished_at,
    validation: evaluation.validation,
    sections: checklist.sections,
  };
  if (!evaluation.result) return { ...base, criteria: [], gross_errors: [], original: null, final: null, appeals };

  const { result } = evaluation;
  const originalAnswers = answersFrom(result, checklist);
  const finalAnswers = applyDecisions(originalAnswers, appeals);
  const original = computeAll(checklist, originalAnswers);
  const final = computeAll(checklist, finalAnswers);

  const criteria = checklist.criteria.map((c) => {
    const item = result.criteria.find((x) => x.id === c.id);
    const gross = result.gross_errors.filter((g) => g.criterion_id === c.id);
    const appeal = appeals.filter((a) => a.criterion_id === c.id).at(-1) ?? null;
    return {
      id: c.id,
      title: c.title,
      section: c.section,
      type: c.type,
      weight: c.weight,
      scale: c.scale ?? null,
      scale_labels: c.scale_labels ?? null,
      na_allowed: c.na_allowed,
      na_condition: c.na_condition,
      definition: c.definition,
      decision_values: decisionValues(c),
      original: pick(original, c.id),
      final: pick(final, c.id),
      explanation: c.type === 'flag'
        ? (gross.length ? gross.map((g) => g.explanation).join(' ') : 'Грубых ошибок не найдено.')
        : item?.explanation ?? null,
      evidence: c.type === 'flag' ? gross.map((g) => ({ msg_id: g.msg_id, quote: g.quote, verified: g.verified, type: g.type })) : item?.evidence ?? [],
      expected_at: item?.expected_at ?? [],
      na_reason: item?.na_reason ?? null,
      confidence: item?.confidence ?? null,
      needs_review: c.type === 'flag' ? gross.some((g) => g.needs_review) : Boolean(item?.needs_review),
      review_reasons: c.type === 'flag' ? gross.flatMap((g) => g.review_reasons) : item?.review_reasons ?? [],
      gross_errors: gross,
      appeal,
    };
  });

  return {
    ...base,
    client_language: result.client_language,
    intent: result.intent,
    original: { answers: originalAnswers, scores: original },
    final: { answers: finalAnswers, scores: final },
    changed: JSON.stringify(originalAnswers) !== JSON.stringify(finalAnswers),
    criteria,
    gross_errors: result.gross_errors,
    // Решения проверяющего по другим диалогам, которые были в промпте.
    precedents: result.precedents ?? [],
    appeals,
  };
}

/** Фрагмент для проверяющего: реплики-доказательства и места ожидания с соседями. */
export function fragmentFor(messages, ids, radius = 2) {
  const index = new Map(messages.map((m, i) => [m.id, i]));
  const anchors = ids.filter((id) => index.has(id)).map((id) => index.get(id));
  if (anchors.length === 0) return messages.slice(0, 2 * radius + 1);
  const keep = new Set(anchors.flatMap((i) => Array.from({ length: 2 * radius + 1 }, (_, k) => i - radius + k)));
  return messages.filter((_, i) => keep.has(i)).map((m) => ({ ...m, anchor: ids.includes(m.id) }));
}
