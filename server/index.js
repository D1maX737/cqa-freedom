import path from 'node:path';
import { config, ROOT } from './config.js';
import { openDb } from './db.js';
import { loadKb } from './kb.js';
import { createLlm } from './llm/index.js';
import { createApp } from './app.js';

const db = openDb(config.dbPath);
db.evaluations.failInterrupted();
const kbDocs = loadKb(path.join(ROOT, 'server', 'kb'));
const app = createApp({ db, settings: config, createLlm, kbDocs });

app.listen(config.port, config.host, () => {
  console.log(`CQA: http://${config.host}:${config.port}`);
  console.log(`LLM: ${config.llmProvider}${config.llmProvider === 'anthropic' ? ` (${config.anthropicModel})` : ''}, база знаний: ${kbDocs.length} док.`);
});
