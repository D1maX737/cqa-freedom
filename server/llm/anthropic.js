import Anthropic from '@anthropic-ai/sdk';

// $ за 1 млн токенов, первичный API Anthropic (таблица скилла claude-api от 2026-10-06).
// Запись в кэш стоит 1.25× входа, чтение — по прайсу модели или 0.1× входа.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

// У этих моделей есть серверный fallback при отказе классификатора безопасности.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

export function estimateCost(model, usage) {
  const price = PRICES[model];
  if (!price) return null;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  // В ответе API input_tokens не включает токены, прочитанные из кэша или записанные в него.
  return (usage.input_tokens * price.input
    + usage.output_tokens * price.output
    + cacheRead * (price.cacheRead ?? price.input * 0.1)
    + cacheWrite * price.input * 1.25) / 1e6;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createAnthropicLlm({ anthropicApiKey, anthropicModel, anthropicEffort, client }) {
  const api = client ?? new Anthropic({ apiKey: anthropicApiKey, maxRetries: 3 });
  const model = anthropicModel;

  return {
    name: 'anthropic',
    model,
    async evaluate(prompt, schema) {
      const params = {
        model,
        max_tokens: 16000,
        system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt.user }],
        output_config: { effort: anthropicEffort, format: { type: 'json_schema', schema } },
      };
      if (FALLBACK_MODELS.has(model)) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

      const response = await api.beta.messages.create(params);
      const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      const usage = {
        input_tokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      };
      return {
        json: response.stop_reason === 'refusal' ? null : parseJson(text),
        raw: JSON.stringify({ id: response.id, stop_reason: response.stop_reason, stop_details: response.stop_details ?? null, text }),
        model: response.model,
        usage,
        cost_usd: estimateCost(response.model, response.usage),
      };
    },
  };
}
