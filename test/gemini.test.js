import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiLlm, parseModelJson, retryDelayMs } from '../server/llm/gemini.js';

const KEY = `AIza${'K'.repeat(35)}`;
const prompt = { system: 'SYSTEM', user: 'USER', context: { secret: 'не должно уйти в API' } };
const schema = { type: 'object', additionalProperties: false, required: [], properties: {} };

const ok = (over = {}) => ({
  status: 200,
  body: {
    candidates: [{
      content: { parts: [{ text: 'план', thought: true }, { text: '{"criteria":[]}' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 800, thoughtsTokenCount: 200, totalTokenCount: 4000 },
    modelVersion: 'gemma-4-31b-it',
    ...over,
  },
});
const error = (status, message, details = []) => ({ status, body: { error: { code: status, message, status: 'X', details } } });

/** fetch-заглушка: отдаёт ответы по очереди и запоминает запросы. */
function fakeFetch(...responses) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    return { ok: next.status < 400, status: next.status, json: async () => next.body, text: async () => JSON.stringify(next.body) };
  };
  return { sent, fetchImpl };
}

/** Часы без настоящего ожидания: время стоит, паузы только записываются, как у параллельных вызовов. */
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); };
  return clock;
}

const llmWith = (fetchImpl, over = {}) => {
  const clock = over.clock ?? fakeClock();
  return createGeminiLlm({ geminiApiKey: KEY, geminiModel: 'gemma-4-31b-it', geminiRpm: 0, fetchImpl, now: clock.now, sleep: clock.sleep, ...over });
};

test('запрос: модель в адресе, ключ только в заголовке, системный промпт и схема ответа', async () => {
  const { sent, fetchImpl } = fakeFetch(ok());
  await llmWith(fetchImpl).evaluate(prompt, schema);
  const [{ url, init, body }] = sent;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent');
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.ok(!url.includes(KEY));
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'SYSTEM' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'USER' }] }]);
  assert.deepEqual(body.generationConfig, { responseMimeType: 'application/json', responseJsonSchema: schema });
  assert.ok(!init.body.includes('не должно уйти'));
});

test('уровень рассуждений передаётся, только если задан', async () => {
  const { sent, fetchImpl } = fakeFetch(ok());
  await llmWith(fetchImpl, { geminiThinking: 'minimal' }).evaluate(prompt, schema);
  assert.deepEqual(sent[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
});

test('ответ: JSON из текста без рассуждений, токены рассуждений считаются выходом, стоимость 0', async () => {
  const { fetchImpl } = fakeFetch(ok());
  const out = await llmWith(fetchImpl).evaluate(prompt, schema);
  assert.deepEqual(out.json, { criteria: [] });
  assert.equal(out.model, 'gemma-4-31b-it');
  assert.deepEqual(out.usage, { input_tokens: 3000, output_tokens: 1000, thoughts_tokens: 200 });
  assert.equal(out.cost_usd, 0);
  assert.match(out.raw, /"finishReason":"STOP"/);
  assert.ok(!out.raw.includes('план'), 'рассуждения модели не сохраняются как ответ');
});

test('обрезанный ответ даёт null, а не исключение', async () => {
  const { fetchImpl } = fakeFetch(ok({ candidates: [{ content: { parts: [{ text: '{"crit' }] }, finishReason: 'MAX_TOKENS' }] }));
  const out = await llmWith(fetchImpl).evaluate(prompt, schema);
  assert.equal(out.json, null);
  assert.match(out.raw, /MAX_TOKENS/);
});

test('заблокированный промпт: кандидатов нет, причина сохраняется', async () => {
  const { fetchImpl } = fakeFetch({ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 10 } } });
  const out = await llmWith(fetchImpl).evaluate(prompt, schema);
  assert.equal(out.json, null);
  assert.match(out.raw, /SAFETY/);
});

test('JSON в обёртке ```json и с текстом вокруг тоже разбирается', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Вот ответ: {"a":{"b":2}} готово'), { a: { b: 2 } });
  assert.equal(parseModelJson('не json'), null);
});

test('429: ждёт retryDelay из ответа API и повторяет', async () => {
  const retryInfo = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }];
  const { sent, fetchImpl } = fakeFetch(error(429, 'quota', retryInfo), ok());
  const clock = fakeClock();
  const out = await llmWith(fetchImpl, { clock }).evaluate(prompt, schema);
  assert.deepEqual(out.json, { criteria: [] });
  assert.equal(sent.length, 2);
  assert.deepEqual(clock.sleeps, [7000]);
});

test('503 без retryDelay: экспоненциальная пауза и повтор', async () => {
  const { sent, fetchImpl } = fakeFetch(error(503, 'overloaded'), error(503, 'overloaded'), ok());
  const clock = fakeClock();
  await llmWith(fetchImpl, { clock }).evaluate(prompt, schema);
  assert.equal(sent.length, 3);
  assert.deepEqual(clock.sleeps, [5000, 10000]);
});

test('дневной лимит: при долгом retryDelay не ждёт, а сообщает понятную ошибку', async () => {
  const retryInfo = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5400s' }];
  const { sent, fetchImpl } = fakeFetch(error(429, 'quota exceeded', retryInfo));
  await assert.rejects(llmWith(fetchImpl).evaluate(prompt, schema), /лимит бесплатного тарифа.*90 мин/);
  assert.equal(sent.length, 1);
});

test('повторы ограничены: после исчерпания попыток ошибка со статусом', async () => {
  const { sent, fetchImpl } = fakeFetch(...Array.from({ length: 4 }, () => error(503, 'overloaded')));
  await assert.rejects(llmWith(fetchImpl, { maxRetries: 3 }).evaluate(prompt, schema), /Gemini API 503/);
  assert.equal(sent.length, 4);
});

test('ошибка без повтора (403) не раскрывает ключ', async () => {
  const { fetchImpl } = fakeFetch(error(403, 'API key not valid'));
  await assert.rejects(llmWith(fetchImpl).evaluate(prompt, schema), (err) => {
    assert.match(err.message, /Gemini API 403: API key not valid/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('модель без JSON-режима: повтор без схемы, дальше схема не отправляется', async () => {
  const { sent, fetchImpl } = fakeFetch(error(400, 'JSON mode is not enabled for models/gemma-4-31b-it'), ok(), ok());
  const llm = llmWith(fetchImpl);
  const out = await llm.evaluate(prompt, schema);
  assert.deepEqual(out.json, { criteria: [] });
  assert.equal(sent.length, 2);
  assert.equal('responseJsonSchema' in sent[1].body.generationConfig, false);
  await llm.evaluate(prompt, schema);
  assert.equal('responseJsonSchema' in sent[2].body.generationConfig, false);
});

test('лимит запросов в минуту: параллельные вызовы разносятся по времени', async () => {
  const { fetchImpl } = fakeFetch(ok(), ok(), ok());
  const clock = fakeClock();
  const llm = llmWith(fetchImpl, { clock, geminiRpm: 15 });
  await Promise.all([llm.evaluate(prompt, schema), llm.evaluate(prompt, schema), llm.evaluate(prompt, schema)]);
  assert.deepEqual(clock.sleeps, [4000, 8000]);
});

test('retryDelayMs: секунды из RetryInfo или экспонента с потолком', () => {
  assert.equal(retryDelayMs({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.5s' }] } }, 0), 1500);
  assert.equal(retryDelayMs({}, 0), 5000);
  assert.equal(retryDelayMs(null, 10), 60000);
});
