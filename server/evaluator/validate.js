import { allowedAnswers, flagTypes } from '../checklist.js';

export const normalizeForMatch = (text) => String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();

export function quoteMatches(message, quote) {
  const needle = normalizeForMatch(quote);
  return needle.length > 0 && normalizeForMatch(message.text).includes(needle);
}

function checkQuote(error, messages, msgId, quote, label) {
  const message = messages.get(msgId);
  if (!message) return error('unknown_msg', `${label}: реплики ${msgId} нет в диалоге`);
  if (!quoteMatches(message, quote)) return error('quote_mismatch', `${label}: цитаты «${quote}» нет в реплике ${msgId}`);
  return undefined;
}

function validateCriterion(item, criterion, messages, push) {
  const error = (code, message) => push(criterion.id, code, message);
  const answer = String(item.answer);
  if (!allowedAnswers(criterion).includes(answer)) {
    error('invalid_answer', `ответ «${answer}» недопустим, можно: ${allowedAnswers(criterion).join(', ')}`);
    return;
  }

  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const expected = Array.isArray(item.expected_at) ? item.expected_at : [];
  for (const entry of evidence) checkQuote(error, messages, entry.msg_id, entry.quote, 'доказательство');
  for (const id of expected) if (!messages.has(id)) error('unknown_msg', `expected_at: реплики ${id} нет в диалоге`);

  const isScale = criterion.type === 'scale';
  const positive = answer === 'yes' || (isScale && answer !== 'na' && Number(answer) > 0);
  const negative = answer === 'no' || (isScale && Number(answer) === 0);
  if (answer === 'na') {
    if (!item.na_reason?.trim()) error('missing_na_reason', 'для N/A нужна причина с условием неприменимости');
  } else if (positive) {
    if (evidence.length === 0) error('missing_evidence', 'для положительной оценки нужно доказательство');
  } else if (negative && expected.length === 0 && (answer === 'no' || evidence.length === 0)) {
    error('missing_expected', 'укажите в expected_at реплику, где ожидалось действие');
  }
}

function validateGross(entry, checklist, messages, push) {
  const type = flagTypes(checklist).find((t) => t.id === entry.type);
  if (!type) {
    push(null, 'invalid_gross_type', `неизвестный тип грубой ошибки «${entry.type}»`);
    return;
  }
  const error = (code, message) => push(type.criterion_id, code, message);
  const problem = checkQuote(error, messages, entry.msg_id, entry.quote, 'грубая ошибка');
  if (problem === undefined && messages.get(entry.msg_id).speaker !== 'operator') {
    error('gross_not_operator', `реплика ${entry.msg_id} не принадлежит оператору`);
  }
}

export function validateResponse(response, checklist, normalized) {
  const errors = [];
  const push = (criterionId, code, message) => {
    errors.push({ criterion_id: criterionId, code, message });
    return true;
  };
  if (!response || typeof response !== 'object' || !Array.isArray(response.criteria)) {
    push(null, 'invalid_format', 'ответ не является JSON нужной формы');
    return errors;
  }

  const messages = new Map(normalized.messages.map((m) => [m.id, m]));
  const known = new Map(checklist.criteria.map((c) => [c.id, c]));
  const seen = new Set();
  for (const item of response.criteria) {
    const criterion = known.get(item.id);
    if (!criterion) push(item.id ?? null, 'unknown_criterion', `в чек-листе нет критерия ${item.id}`);
    else if (seen.has(item.id)) push(item.id, 'duplicate_criterion', 'критерий повторён дважды');
    else if (criterion.type !== 'flag') {
      seen.add(item.id);
      validateCriterion(item, criterion, messages, push);
    }
  }
  for (const criterion of checklist.criteria) {
    if (criterion.type !== 'flag' && criterion.weight > 0 && !seen.has(criterion.id)) {
      push(criterion.id, 'missing_criterion', 'критерий не оценён');
    }
  }
  for (const entry of Array.isArray(response.gross_errors) ? response.gross_errors : []) {
    validateGross(entry, checklist, messages, push);
  }
  return errors;
}

export function problemCriteria(errors) {
  const map = new Map();
  for (const error of errors) {
    if (error.criterion_id === null) continue;
    map.set(error.criterion_id, [...(map.get(error.criterion_id) ?? []), error]);
  }
  return map;
}
