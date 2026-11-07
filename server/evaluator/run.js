import { allowedAnswers, flagTypes } from '../checklist.js';
import { normalizeConversation } from '../normalize.js';
import { buildPrompt, buildRetryPrompt } from './prompt.js';
import { collectPrecedents } from '../precedents.js';
import { buildRecheckPrompt, mergeRecheck, riskyCriteria } from './recheck.js';
import { buildResponseSchema } from './schema.js';
import { problemCriteria, quoteMatches, validateResponse } from './validate.js';

const reasons = (problems) => problems.map((p) => `${p.code}: ${p.message}`);

/** Сколько критериев ответ оставил непригодными. Ответ без JSON непригоден целиком. */
function badness(errors) {
  if (errors.some((e) => e.code === 'invalid_format')) return Infinity;
  return new Set(errors.map((e) => e.criterion_id ?? `${e.code}:${e.message}`)).size;
}

function assembleCriterion(criterion, item, problems, messages) {
  const answer = item && allowedAnswers(criterion).includes(String(item.answer)) ? String(item.answer) : null;
  const evidence = (item?.evidence ?? [])
    .filter((entry) => messages.has(entry.msg_id))
    .map((entry) => ({ ...entry, verified: quoteMatches(messages.get(entry.msg_id), entry.quote) }));
  return {
    id: criterion.id,
    answer,
    explanation: item?.explanation ?? 'Модель не вернула оценку по этому критерию.',
    evidence,
    expected_at: (item?.expected_at ?? []).filter((id) => messages.has(id)),
    na_reason: item?.na_reason ?? null,
    confidence: item?.confidence ?? null,
    needs_review: problems.length > 0 || !item,
    review_reasons: reasons(problems),
  };
}

function assembleGross(entries, checklist, messages, problems) {
  const types = new Map(flagTypes(checklist).map((t) => [t.id, t]));
  return (entries ?? []).filter((entry) => types.has(entry.type)).map((entry) => {
    const { criterion_id: criterionId } = types.get(entry.type);
    const message = messages.get(entry.msg_id);
    const verified = Boolean(message) && message.speaker === 'operator' && quoteMatches(message, entry.quote);
    return {
      ...entry,
      criterion_id: criterionId,
      verified,
      needs_review: !verified,
      review_reasons: verified ? [] : reasons(problems.get(criterionId) ?? []),
    };
  });
}

export function assembleResult(response, checklist, normalized, errors) {
  const items = new Map();
  for (const item of Array.isArray(response?.criteria) ? response.criteria : []) {
    if (!items.has(item.id)) items.set(item.id, item);
  }
  const messages = new Map(normalized.messages.map((m) => [m.id, m]));
  const problems = problemCriteria(errors);
  const criteria = checklist.criteria
    .filter((c) => c.type !== 'flag' && (c.weight > 0 || items.has(c.id)))
    .map((c) => assembleCriterion(c, items.get(c.id), problems.get(c.id) ?? [], messages));
  return {
    client_language: response?.client_language ?? normalized.facts.client_language.value,
    intent: response?.intent ?? '',
    criteria,
    gross_errors: assembleGross(response?.gross_errors, checklist, messages, problems),
  };
}

export async function evaluateConversation({ conversation, checklist, llm, kbDocs, uiLanguage, precedents = [], recheck = false }) {
  const normalized = normalizeConversation(conversation, { pauseThresholdSec: checklist.settings?.pause_threshold_sec });
  const prompt = { ...buildPrompt({ checklist, normalized, kbDocs, uiLanguage, precedents }), context: { checklist, normalized } };
  const schema = buildResponseSchema(checklist);
  const validate = (output) => validateResponse(output.json, checklist, normalized);

  const responses = [await llm.evaluate(prompt, schema)];
  let best = responses[0];
  let errors = validate(best);
  let attempts = 1;

  if (errors.length > 0) {
    attempts = 2;
    try {
      const retry = await llm.evaluate(buildRetryPrompt(prompt, best.json, errors), schema);
      responses.push(retry);
      const retryErrors = validate(retry);
      // Повтор может оказаться хуже: например, вернуть ответ без JSON. Тогда оставляем первый.
      if (badness(retryErrors) <= badness(errors)) {
        best = retry;
        errors = retryErrors;
      }
    } catch (error) {
      errors = [...errors, { criterion_id: null, code: 'retry_failed', message: error.message }];
    }
  }

  // Второй проход по рискованным ответам: берётся, только если не хуже первого по проверке.
  let recheckInfo;
  if (recheck && best.json && badness(errors) !== Infinity) {
    const risky = riskyCriteria(best.json, checklist);
    if (risky.criteria.length || risky.gross) {
      recheckInfo = { criteria: risky.criteria, gross: risky.gross, changed: [] };
      attempts += 1;
      try {
        const second = await llm.evaluate(buildRecheckPrompt(prompt, best.json, risky), schema);
        responses.push(second);
        const { merged, changed } = mergeRecheck(best.json, second.json, risky);
        const mergedErrors = validate({ json: merged });
        if (badness(mergedErrors) <= badness(errors)) {
          best = { ...best, json: merged };
          errors = mergedErrors;
          recheckInfo.changed = changed;
        } else {
          recheckInfo.kept_first = true;
        }
      } catch (error) {
        recheckInfo.error = error.message;
      }
    }
  }

  const result = assembleResult(best.json, checklist, normalized, errors);
  if (recheckInfo) result.recheck = recheckInfo;
  // Какие решения проверяющего были в промпте: видно в карточке.
  if (precedents.length) result.precedents = precedents.map(({ appeal_id, conversation_id, criterion_id }) => ({ appeal_id, conversation_id, criterion_id }));
  const sum = (key) => responses.reduce((total, r) => total + (r.usage?.[key] ?? 0), 0);
  return {
    model: best.model,
    attempts,
    result,
    validation: errors,
    needs_review: errors.length > 0 || result.criteria.some((c) => c.needs_review),
    raw_responses: responses.map((r) => ({ raw: r.raw, model: r.model, usage: r.usage, cost_usd: r.cost_usd ?? 0 })),
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cost_usd: responses.reduce((total, r) => total + (r.cost_usd ?? 0), 0),
  };
}

export async function runEvaluation({ db, llm, evaluationId, kbDocs, uiLanguage, usePrecedents = true, recheck = false }) {
  const evaluation = db.evaluations.get(evaluationId);
  db.evaluations.markRunning(evaluationId);
  try {
    const checklist = db.checklists.get(evaluation.checklist_version_id).config;
    const outcome = await evaluateConversation({
      conversation: db.conversations.get(evaluation.conversation_id),
      checklist,
      llm,
      kbDocs,
      uiLanguage,
      precedents: usePrecedents ? collectPrecedents(db, { checklist, conversationId: evaluation.conversation_id }) : [],
      recheck,
    });
    db.evaluations.finish(evaluationId, outcome);
  } catch (error) {
    db.evaluations.fail(evaluationId, error.message);
  }
}
