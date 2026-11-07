import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicLlm, estimateCost } from '../server/llm/anthropic.js';

const prompt = { system: 'SYSTEM', user: 'USER', context: { secret: 'не должно уйти в API' } };
const schema = { type: 'object', additionalProperties: false, required: [], properties: {} };
const reply = (over = {}) => ({
  id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"criteria":[]}' }],
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
  ...over,
});
const fakeClient = (response) => {
  const sent = [];
  return { sent, beta: { messages: { create: async (params) => { sent.push(params); return response; } } } };
};
const llmWith = (client, model = 'claude-opus-5-5') => createAnthropicLlm({ anthropicApiKey: 'k', anthropicModel: model, anthropicEffort: 'high', client });

test('запрос: схема ответа, effort, кэш системного промпта, без temperature', async () => {
  const client = fakeClient(reply());
  await llmWith(client).evaluate(prompt, schema);
  const [params] = client.sent;
  assert.deepEqual(params.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
  assert.deepEqual(params.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(params.messages, [{ role: 'user', content: 'USER' }]);
  assert.equal('temperature' in params, false);
  assert.equal('thinking' in params, false);
  assert.ok(!JSON.stringify(params).includes('не должно уйти'));
});

test('для Opus 5.5 включён серверный fallback при отказе', async () => {
  const client = fakeClient(reply());
  await llmWith(client).evaluate(prompt, schema);
  assert.equal(client.sent[0].fallbacks, 'default');
  assert.deepEqual(client.sent[0].betas, ['server-side-fallback-2026-07-01']);
});

test('для Haiku 5.5 fallback не передаётся: у него нет серверного fallback', async () => {
  const client = fakeClient(reply({ model: 'claude-haiku-5-5' }));
  await llmWith(client, 'claude-haiku-5-5').evaluate(prompt, schema);
  assert.equal('fallbacks' in client.sent[0], false);
});

test('JSON берётся из текстового блока, блоки рассуждений пропускаются', async () => {
  const out = await llmWith(fakeClient(reply())).evaluate(prompt, schema);
  assert.deepEqual(out.json, { criteria: [] });
  assert.equal(out.model, 'claude-opus-5-5');
});

test('отказ модели не роняет оценку, а даёт пустой JSON с причиной', async () => {
  const out = await llmWith(fakeClient(reply({ stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } }))).evaluate(prompt, schema);
  assert.equal(out.json, null);
  assert.match(out.raw, /refusal/);
});

test('обрезанный JSON даёт null, а не исключение', async () => {
  const out = await llmWith(fakeClient(reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"crit' }] }))).evaluate(prompt, schema);
  assert.equal(out.json, null);
});

test('токены включают запись и чтение кэша', async () => {
  const out = await llmWith(fakeClient(reply())).evaluate(prompt, schema);
  assert.equal(out.usage.input_tokens, 5000);
  assert.equal(out.usage.cache_read_input_tokens, 4000);
});

test('стоимость считается по прайсу модели с учётом кэша', () => {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 };
  // Opus 5.5: $4 вход, $20 выход, $0.20 чтение кэша, запись 1.25×вход
  const expected = (1000 * 4 + 500 * 20 + 4000 * 0.2 + 2000 * 5) / 1e6;
  assert.equal(estimateCost('claude-opus-5-5', usage), expected);
});

test('для неизвестной модели стоимость не выдумывается', () => {
  assert.equal(estimateCost('claude-unknown', { input_tokens: 1, output_tokens: 1 }), null);
});
