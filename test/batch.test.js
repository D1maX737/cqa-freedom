import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../server/db.js';
import { loadSeedChecklist } from '../server/checklist.js';
import { createMockLlm } from '../server/llm/mock.js';
import { parseArgs, planBatch, runBatch } from '../server/evaluator/batch.js';

const { data } = JSON.parse(fs.readFileSync(new URL('../data/dev.sample.json', import.meta.url), 'utf8'));
const setup = () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', data.records);
  db.checklists.create('v1', loadSeedChecklist());
  return db;
};

test('аргументы: набор, версия, параллелизм, повтор и лимит', () => {
  assert.deepEqual(parseArgs(['DEV', '--checklist', 'v2', '--concurrency', '8', '--force', '--limit', '3']),
    { group: 'DEV', checklist: 'v2', concurrency: 8, force: true, limit: 3 });
  assert.deepEqual(parseArgs(['CTRL']), { group: 'CTRL', checklist: null, concurrency: null, force: false, limit: null });
});

test('план пропускает уже оценённые этой версией диалоги', async () => {
  const db = setup();
  await runBatch({ db, llm: createMockLlm(), ids: ['p1-ru-001'], versionId: 'v1', concurrency: 1, kbDocs: [], uiLanguage: 'RU' });
  assert.deepEqual(planBatch(db, { group: 'DEV', versionId: 'v1', force: false }), ['p1-en-001', 'p1-kz-001']);
  assert.equal(planBatch(db, { group: 'DEV', versionId: 'v1', force: true }).length, 3);
});

test('лимит ограничивает план', () => {
  assert.equal(planBatch(setup(), { group: 'DEV', versionId: 'v1', force: false, limit: 2 }).length, 2);
});

test('прогон сохраняет оценки и считает сводку со стоимостью одной оценки', async () => {
  const db = setup();
  const summary = await runBatch({ db, llm: createMockLlm(), ids: ['p1-ru-001', 'p1-kz-001', 'p1-en-001'], versionId: 'v1', concurrency: 2, kbDocs: [], uiLanguage: 'RU' });
  assert.equal(summary.done, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.cost_per_evaluation, 0);
  assert.ok(summary.input_tokens > 0);
  assert.equal(db.evaluations.latestFor('p1-kz-001', 'v1').status, 'done');
});

test('сбой провайдера учитывается в сводке, а не роняет прогон', async () => {
  const summary = await runBatch({ db: setup(), llm: createMockLlm({ fault: 'throw' }), ids: ['p1-ru-001'], versionId: 'v1', concurrency: 1, kbDocs: [], uiLanguage: 'RU' });
  assert.equal(summary.failed, 1);
  assert.equal(summary.done, 0);
});
