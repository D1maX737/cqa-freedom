import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from '../server/llm/index.js';

test('mock выбирается по имени провайдера', async () => {
  assert.equal((await createLlm({ llmProvider: 'mock' })).name, 'mock');
});

test('anthropic без ключа даёт понятную ошибку до первого запроса', async () => {
  await assert.rejects(createLlm({ llmProvider: 'anthropic', anthropicApiKey: '' }), /ANTHROPIC_API_KEY/);
});

test('неизвестный провайдер отклоняется', async () => {
  await assert.rejects(createLlm({ llmProvider: 'gpt' }), /провайдер/);
});
