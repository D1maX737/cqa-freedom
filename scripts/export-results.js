#!/usr/bin/env node
// Выгрузка результатов в формат организаторов:
//   node scripts/export-results.js DEV dev            → results/dev/results.json
//   node scripts/export-results.js <GROUP_ID> prod    → results/prod/results.json
// Ключи: --checklist v1 (по умолчанию последняя версия), --team "Команда" (или TEAM_NAME в .env),
//        --original (без решений проверяющего), --allow-mock (только для проверки формата).
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../server/config.js';
import { openDb } from '../server/db.js';
import { loadSeedChecklist } from '../server/checklist.js';
import { collectResults } from '../server/export.js';
import { configuredModel } from '../server/llm/index.js';

const PROD_SIZE = 10;

function parseArgs(argv) {
  const args = { positional: [], checklist: null, team: process.env.TEAM_NAME ?? '', original: false, allowMock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--checklist') args.checklist = argv[++i];
    else if (arg === '--team') args.team = argv[++i] ?? '';
    else if (arg === '--original') args.original = true;
    else if (arg === '--allow-mock') args.allowMock = true;
    else args.positional.push(arg);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [groupId, set] = args.positional;
if (!groupId || !['dev', 'prod'].includes(set)) {
  console.error('Использование: npm run export -- <GROUP_ID> <dev|prod> [--checklist v1] [--team "Команда"] [--original]');
  process.exit(1);
}

const db = openDb(config.dbPath);
if (db.checklists.list().length === 0) db.checklists.create('Чек-лист организаторов', loadSeedChecklist());
const versionId = args.checklist ?? db.checklists.latest()?.id;
let output;
try {
  const fallbackModel = { mode: ['ollama', 'mock'].includes(config.llmProvider) ? 'local' : 'external_api', name: configuredModel(config) };
  output = collectResults(db, { groupId, versionId, teamName: args.team, useFinal: !args.original, allowMock: args.allowMock, fallbackModel });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { file, errors, summary } = output;
console.log(`Набор ${groupId}, чек-лист ${summary.versionId}, модель: ${file.model.name || '—'} (${file.model.mode})`);
console.log(`Диалогов: ${summary.total}, оценено: ${summary.ok}, с ошибкой: ${summary.failed.length}`);
for (const record of summary.failed) console.log(`  ${record.conversation_id}: ${record.error}`);
if (summary.withDecisions) {
  console.log(`Учтены решения проверяющего в ${summary.withDecisions} диалогах${args.original ? '' : ' (без них: --original)'}`);
}
if (set === 'prod' && summary.total !== PROD_SIZE) console.log(`Внимание: в контрольном наборе ${summary.total} диалогов, а организаторы ждут ${PROD_SIZE}`);

if (errors.length) {
  console.error(`\nФайл не записан, формат нарушен:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  process.exit(1);
}
const target = path.join(ROOT, 'results', set, 'results.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`\nЗаписано: ${path.relative(ROOT, target)}. Формат проверен.${summary.failed.length ? ' Диалоги с ошибкой можно оценить заново: npm run batch и повторить выгрузку.' : ''}`);
console.log(`Дальше: git add ${path.relative(ROOT, target)} && git commit && git push — до стоп-кода.`);
