import { createMockLlm } from './mock.js';

/** Единый интерфейс провайдеров: evaluate(prompt, schema) → { json, raw, model, usage, cost_usd }. */
export async function createLlm(settings) {
  if (settings.llmProvider === 'mock') return createMockLlm();
  if (settings.llmProvider === 'anthropic') {
    if (!settings.anthropicApiKey) throw new Error('Для LLM_PROVIDER=anthropic нужен ANTHROPIC_API_KEY в .env');
    const { createAnthropicLlm } = await import('./anthropic.js');
    return createAnthropicLlm(settings);
  }
  throw new Error(`Неизвестный LLM-провайдер «${settings.llmProvider}»: доступны mock и anthropic`);
}
