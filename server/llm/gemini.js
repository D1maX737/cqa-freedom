// Google Gemini API (ключ из AI Studio). Через него же доступны открытые модели Gemma.
// Формат запроса: https://ai.google.dev/api/generate-content
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Дольше ждать нет смысла: это уже дневной лимит, а не минутный.
const MAX_WAIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 280_000;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Пауза перед повтором: retryDelay из google.rpc.RetryInfo или экспонента 5, 10, 20… с потолком в минуту. */
export function retryDelayMs(errorBody, attempt) {
  const info = errorBody?.error?.details?.find((d) => String(d?.['@type']).endsWith('google.rpc.RetryInfo'));
  const seconds = Number.parseFloat(info?.retryDelay);
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  return Math.min(5000 * 2 ** attempt, 60_000);
}

/** Модели без JSON-режима отвечают текстом: JSON может быть в ```json или окружён пояснением. */
export function parseModelJson(text) {
  const attempts = [text, text?.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')];
  const start = text?.indexOf('{') ?? -1;
  const end = text?.lastIndexOf('}') ?? -1;
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch { /* следующий вариант */ }
  }
  return null;
}

export function createGeminiLlm({
  geminiApiKey, geminiModel, geminiThinking = '', geminiRpm = 15, maxRetries = 5,
  fetchImpl = fetch, now = Date.now, sleep = defaultSleep,
}) {
  const model = geminiModel;
  const interval = geminiRpm > 0 ? 60_000 / geminiRpm : 0;
  let nextSlot = 0;
  let schemaSupported = true;

  // Бесплатный тариф ограничивает запросы в минуту: старты разносятся равномерно и при параллельной оценке.
  async function waitForSlot() {
    if (!interval) return;
    const slot = Math.max(now(), nextSlot);
    nextSlot = slot + interval;
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
  }

  function requestBody(prompt, schema) {
    const generationConfig = schemaSupported ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {};
    if (geminiThinking) generationConfig.thinkingConfig = { thinkingLevel: geminiThinking };
    return {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      generationConfig,
    };
  }

  async function call(prompt, schema) {
    for (let attempt = 0; ; attempt += 1) {
      await waitForSlot();
      const response = await fetchImpl(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiApiKey },
        body: JSON.stringify(requestBody(prompt, schema)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response.json();

      const body = await response.json().catch(() => null);
      const message = body?.error?.message ?? `HTTP ${response.status}`;
      if (response.status === 400 && schemaSupported && /json|schema|mime/i.test(message)) {
        schemaSupported = false;
        continue;
      }
      if (!RETRYABLE.has(response.status) || attempt >= maxRetries) throw new Error(`Gemini API ${response.status}: ${message}`);
      const delay = retryDelayMs(body, attempt);
      if (delay > MAX_WAIT_MS) {
        throw new Error(`Gemini API ${response.status}: лимит бесплатного тарифа исчерпан, повтор возможен через ${Math.ceil(delay / 60_000)} мин (${message})`);
      }
      await sleep(delay);
    }
  }

  return {
    name: 'gemini',
    model,
    async evaluate(prompt, schema) {
      const data = await call(prompt, schema);
      const candidate = data.candidates?.[0];
      // Части с thought: true — рассуждения модели, ответом они не являются.
      const text = (candidate?.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? '').join('');
      const usage = data.usageMetadata ?? {};
      const thoughts = usage.thoughtsTokenCount ?? 0;
      return {
        json: text ? parseModelJson(text) : null,
        raw: JSON.stringify({
          finishReason: candidate?.finishReason ?? null,
          blockReason: data.promptFeedback?.blockReason ?? null,
          modelVersion: data.modelVersion ?? null,
          text,
        }),
        model: data.modelVersion ?? model,
        usage: { input_tokens: usage.promptTokenCount ?? 0, output_tokens: (usage.candidatesTokenCount ?? 0) + thoughts, thoughts_tokens: thoughts },
        // Бесплатный тариф AI Studio.
        cost_usd: 0,
      };
    },
  };
}
