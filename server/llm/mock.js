import { createHash } from 'node:crypto';
import { allowedAnswers, flagTypes } from '../checklist.js';

const MODEL = 'mock-deterministic';
const hash = (text) => createHash('sha256').update(text).digest().readUInt32BE(0);
const estimateTokens = (text) => Math.ceil(text.length / 3);
const BAD_QUOTE = '__цитаты_нет_в_реплике__';

function answerCriterion(criterion, conversationId, messages) {
  const h = hash(`${conversationId}:${criterion.id}`);
  const operator = messages.filter((m) => m.speaker === 'operator');
  const pool = operator.length ? operator : messages;
  const target = pool[h % pool.length];
  const base = { id: criterion.id, evidence: [], expected_at: [], na_reason: null, confidence: 0.5 + ((h >>> 8) % 50) / 100 };

  if (criterion.na_allowed && h % 100 < 20) {
    return { ...base, answer: 'na', explanation: '[mock] Заглушка: критерий отмечен как неприменимый.', na_reason: `[mock] ${criterion.na_condition}` };
  }
  const options = allowedAnswers(criterion).filter((a) => a !== 'na');
  const picked = options[Math.floor(Math.sqrt(((h >>> 4) % 1000) / 1000) * options.length)];
  const positive = picked === 'yes' || (criterion.type === 'scale' && Number(picked) > 0);
  if (!positive) {
    return { ...base, answer: picked, explanation: '[mock] Заглушка: действие не засчитано.', expected_at: [target.id] };
  }
  return {
    ...base,
    answer: picked,
    explanation: '[mock] Заглушка: это не оценка модели, а детерминированный ответ для проверки интерфейса.',
    evidence: [{ msg_id: target.id, quote: target.text.slice(0, 60).trim() }],
  };
}

function grossErrors(checklist, conversationId, messages) {
  const types = flagTypes(checklist);
  const operator = messages.filter((m) => m.speaker === 'operator');
  const h = hash(`${conversationId}:gross`);
  if (types.length === 0 || operator.length === 0 || h % 100 >= 8) return [];
  const target = operator[h % operator.length];
  return [{
    type: types[h % types.length].id,
    msg_id: target.id,
    quote: target.text.slice(0, 60).trim(),
    explanation: '[mock] Заглушка: флаг выставлен для проверки интерфейса.',
  }];
}

function buildResponse({ checklist, normalized }) {
  const { conversation_id: id, messages, facts } = normalized;
  const client = messages.find((m) => m.speaker === 'client');
  return {
    client_language: facts.client_language.value ?? normalized.language,
    intent: `[mock] ${(client?.text ?? '').slice(0, 80)}`,
    criteria: checklist.criteria.filter((c) => c.type !== 'flag').map((c) => answerCriterion(c, id, messages)),
    gross_errors: grossErrors(checklist, id, messages),
  };
}

function breakQuote(response, { checklist, normalized }) {
  const first = response.criteria[0];
  const criterion = checklist.criteria.find((c) => c.id === first.id);
  const options = allowedAnswers(criterion).filter((a) => a !== 'na');
  Object.assign(first, {
    answer: criterion.type === 'scale' ? options.at(-1) : 'yes',
    evidence: [{ msg_id: normalized.messages[0].id, quote: BAD_QUOTE }],
    expected_at: [],
    na_reason: null,
  });
  return response;
}

const FAULTS = {
  bad_quote_once: (r, ctx, call) => (call === 1 ? breakQuote(r, ctx) : r),
  bad_quote_always: (r, ctx) => breakQuote(r, ctx),
  bad_quote_then_throw: (r, ctx, call) => {
    if (call > 1) throw new Error('mock: сбой сети на повторе');
    return breakQuote(r, ctx);
  },
  bad_quote_then_no_json: (r, ctx, call) => (call === 1 ? breakQuote(r, ctx) : null),
  drop_criterion_always: (r) => ({ ...r, criteria: r.criteria.slice(1) }),
  no_json_once: (r, ctx, call) => (call === 1 ? null : r),
  no_json_always: () => null,
  throw: () => { throw new Error('mock: сбой провайдера'); },
};

/** Без сети и ключа: нужен для тестов и работы интерфейса до подключения настоящей модели. */
export function createMockLlm({ fault } = {}) {
  const calls = [];
  return {
    name: 'mock',
    model: MODEL,
    calls,
    async evaluate(prompt) {
      calls.push(prompt);
      const response = buildResponse(prompt.context);
      const json = fault ? FAULTS[fault](response, prompt.context, calls.length) : response;
      return {
        json,
        raw: JSON.stringify(json),
        model: MODEL,
        usage: { input_tokens: estimateTokens(prompt.system + prompt.user), output_tokens: estimateTokens(JSON.stringify(json) ?? '') },
        cost_usd: 0,
      };
    },
  };
}
