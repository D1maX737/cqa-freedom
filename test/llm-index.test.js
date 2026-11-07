import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredModel, createLlm } from '../server/llm/index.js';

test('mock выбирается по имени провайдера', async () => {
  assert.equal((await createLlm({ llmProvider: 'mock' })).name, 'mock');
});

test('anthropic без ключа даёт понятную ошибку до первого запроса', async () => {
  await assert.rejects(createLlm({ llmProvider: 'anthropic', anthropicApiKey: '' }), /ANTHROPIC_API_KEY/);
});

test('неизвестный провайдер отклоняется', async () => {
  await assert.rejects(createLlm({ llmProvider: 'gpt' }), /провайдер/);
});

test('gemini без ключа даёт понятную ошибку до первого запроса', async () => {
  await assert.rejects(createLlm({ llmProvider: 'gemini', geminiApiKey: '' }), /GEMINI_API_KEY/);
});

test('gemini с ключом создаёт адаптер с моделью из настроек', async () => {
  const llm = await createLlm({ llmProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemma-4-31b-it', geminiRpm: 15 });
  assert.equal(llm.name, 'gemini');
  assert.equal(llm.model, 'gemma-4-31b-it');
});

test('configuredModel показывает модель выбранного провайдера', () => {
  assert.equal(configuredModel({ llmProvider: 'gemini', geminiModel: 'gemma-4-31b-it' }), 'gemma-4-31b-it');
  assert.equal(configuredModel({ llmProvider: 'anthropic', anthropicModel: 'claude-opus-5-5' }), 'claude-opus-5-5');
  assert.equal(configuredModel({ llmProvider: 'mock' }), 'mock-deterministic');
});
