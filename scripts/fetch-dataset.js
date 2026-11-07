#!/usr/bin/env node
// Использование: node scripts/fetch-dataset.js DEV
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { fetchDataset } from '../server/datasource.js';

const groupId = process.argv[2] ?? 'DEV';
const fileName = `${groupId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.json`;

const countBy = (items, key) => Object.fromEntries(
  Object.entries(Object.groupBy(items, (item) => item[key])).map(([name, group]) => [name, group.length]),
);

try {
  const dataset = await fetchDataset(groupId, { baseUrl: config.datasetUrl });
  fs.mkdirSync(config.dataDir, { recursive: true });
  const target = path.join(config.dataDir, fileName);
  fs.writeFileSync(target, JSON.stringify({ isSuccess: true, error: '', data: {
    dataset_group_id: dataset.groupId, total_records: dataset.total, records: dataset.records,
  } }, null, 2));

  const db = openDb(config.dbPath);
  db.conversations.upsertMany(groupId, dataset.records);
  db.close();

  console.log(`Загружено ${dataset.records.length} из ${dataset.total} (${groupId}) в ${path.relative(process.cwd(), target)} и БД`);
  console.log('Каналы:', countBy(dataset.records, 'channel'));
  console.log('Языки:', countBy(dataset.records, 'language'));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
