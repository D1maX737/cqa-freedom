import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Как num, но 0 — допустимое значение.
const count = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),
  // Авторизации нет, поэтому по умолчанию сервис доступен только с этой машины.
  host: process.env.HOST || '127.0.0.1',
  datasetUrl: process.env.DATASET_URL || '',
  audioHostSuffix: process.env.AUDIO_HOST_SUFFIX || '.powerplatform.com',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'cqa.db'),
  dataDir: path.join(ROOT, 'data'),
  llmProvider: process.env.LLM_PROVIDER || 'mock',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  anthropicEffort: process.env.ANTHROPIC_EFFORT || 'high',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  geminiThinking: process.env.GEMINI_THINKING ?? 'high',
  // Запросов в минуту на бесплатном тарифе; 0 — без ограничения.
  geminiRpm: count(process.env.GEMINI_RPM, 14),
  // Сколько ждать ответа: зависший запрос обрывается и повторяется.
  geminiTimeoutSec: num(process.env.GEMINI_TIMEOUT_SEC, 90),
  llmConcurrency: num(process.env.LLM_CONCURRENCY, 4),
  uiLanguage: process.env.UI_LANGUAGE || 'RU',
};
