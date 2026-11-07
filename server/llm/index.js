import { createMockLlm } from './mock.js';

/** Модель, которую покажет шапка интерфейса до первой оценки. */
export function configuredModel(settings) {
  if (settings.llmProvider === 'anthropic') return settings.anthropicModel;
  if (settings.llmProvider === 'gemini') return settings.geminiModel;
  return 'mock-deterministic';
}

/** Единый интерфейс провайдеров: evaluate(prompt, schema) → { json, raw, model, usage, cost_usd }. */
export async function createLlm(settings) {
  if (settings.llmProvider === 'mock') return createMockLlm();
  if (settings.llmProvider === 'anthropic') {
    if (!settings.anthropicApiKey) throw new Error('Для LLM_PROVIDER=anthropic нужен ANTHROPIC_API_KEY в .env');
    const { createAnthropicLlm } = await import('./anthropic.js');
    return createAnthropicLlm(settings);
  }
  if (settings.llmProvider === 'gemini') {
    if (!settings.geminiApiKey) throw new Error('Для LLM_PROVIDER=gemini нужен GEMINI_API_KEY в .env: ключ выдаёт aistudio.google.com/apikey');
    const { createGeminiLlm } = await import('./gemini.js');
    return createGeminiLlm(settings);
  }
  throw new Error(`Неизвестный LLM-провайдер «${settings.llmProvider}»: доступны mock, anthropic и gemini`);
}
