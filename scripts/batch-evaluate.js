#!/usr/bin/env node
// Использование: node scripts/batch-evaluate.js DEV [--checklist v2] [--concurrency 4] [--force] [--limit 3]
import path from 'node:path';
import { config, ROOT } from '../server/config.js';
import { openDb } from '../server/db.js';
import { loadKb } from '../server/kb.js';
import { loadSeedChecklist } from '../server/checklist.js';
import { createLlm } from '../server/llm/index.js';
import { parseArgs, planBatch, runBatch } from '../server/evaluator/batch.js';

const args = parseArgs(process.argv.slice(2));
if (!args.group) {
  console.error('Укажите набор: node scripts/batch-evaluate.js DEV');
  process.exit(1);
}

const db = openDb(config.dbPath);
if (db.checklists.list().length === 0) db.checklists.create('Чек-лист организаторов', loadSeedChecklist());
const version = args.checklist ? db.checklists.get(args.checklist) : db.checklists.latest();
if (!version) {
  console.error(`Версия чек-листа ${args.checklist} не найдена`);
  process.exit(1);
}

const ids = planBatch(db, { group: args.group, versionId: version.id, force: args.force, limit: args.limit });
if (ids.length === 0) {
  console.log(`Нечего оценивать: все диалоги ${args.group} уже оценены версией ${version.id}. Для повтора добавьте --force.`);
  process.exit(0);
}

let llm;
try {
  llm = await createLlm(config);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const concurrency = args.concurrency || config.llmConcurrency;
console.log(`Оцениваю ${ids.length} диалогов ${args.group} версией ${version.id}: ${llm.name} (${llm.model}), параллельно ${concurrency}`);
const decisions = db.appeals.list('decided').filter((a) => a.action === 'change').length;
if (config.usePrecedents && decisions) {
  console.log(`В промпт попадут прецеденты из решений по апелляциям (в базе ${decisions}). Если это тестовые решения, остановите и запустите с PRECEDENTS=0.`);
}
const summary = await runBatch({
  db, llm, ids, versionId: version.id, concurrency,
  kbDocs: loadKb(path.join(ROOT, 'server', 'kb')),
  uiLanguage: config.uiLanguage,
  usePrecedents: config.usePrecedents,
  recheck: config.recheck,
  onProgress: (n, total, e) => console.log(`[${n}/${total}] ${e.conversation_id}: ${e.status}${e.needs_review ? ', на проверку' : ''}${e.error ? ` — ${e.error}` : ''}`),
});

console.log(`\nГотово: ${summary.done}, ошибок: ${summary.failed}, на проверку: ${summary.needs_review}, с повтором: ${summary.retried}`);
console.log(`Токены: вход ${summary.input_tokens}, выход ${summary.output_tokens}; стоимость $${summary.cost_usd.toFixed(4)}`
  + `${summary.cost_per_evaluation !== null ? `, в среднем $${summary.cost_per_evaluation.toFixed(4)} за оценку` : ''}`);
if (summary.errors.length) console.log(`Ошибки:\n  ${summary.errors.join('\n  ')}`);
db.close();
