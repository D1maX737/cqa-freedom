#!/usr/bin/env node
// Сервер для показа на копии рабочей базы: апелляции, подсказки и вставленные диалоги с защиты
// не попадают ни в results.json, ни в прецеденты для контрольного набора.
//   npm run demo            — копия data/demo.db создаётся один раз и дальше переиспользуется
//   npm run demo -- --fresh — свежая копия рабочей базы
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(ROOT, 'data', 'cqa.db');
const target = path.join(ROOT, 'data', 'demo.db');

if (!fs.existsSync(source)) {
  console.error('Нет рабочей базы data/cqa.db: сначала npm run fetch -- DEV и оценка');
  process.exit(1);
}
if (process.argv.includes('--fresh') || !fs.existsSync(target)) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  // backup, а не копирование файла: база в режиме WAL, копия файла может оказаться повреждённой.
  const db = new Database(source, { readonly: true });
  await db.backup(target);
  db.close();
  console.log('Создана копия рабочей базы для показа: data/demo.db');
} else {
  console.log('Показ на копии data/demo.db (свежая копия: npm run demo -- --fresh)');
}

process.env.DB_PATH = target;
await import('../server/index.js');
