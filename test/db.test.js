import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';

const rec = (over = {}) => ({
  conversation_id: 'p4-ru-001', channel: 'voice call', language: 'RU', audio_url: 'https://x/a',
  transcript: [{ timestamp: '2026-11-03T15:49:13.1900670+00:00', speaker: 'system', text: 'Старт' }],
  ...over,
});
const cfg = { title: 'T', sections: [], criteria: [] };

test('исходные timestamp сохраняются без изменений', () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', [rec()]);
  assert.equal(db.conversations.get('p4-ru-001').transcript[0].timestamp, '2026-11-03T15:49:13.1900670+00:00');
  db.close();
});

test('повторная загрузка обновляет запись, а не дублирует', () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', [rec()]);
  db.conversations.upsertMany('DEV', [rec({ language: 'KZ' })]);
  const list = db.conversations.list('DEV');
  assert.equal(list.length, 1);
  assert.equal(list[0].language, 'KZ');
  db.close();
});

test('список фильтруется по группе', () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', [rec()]);
  db.conversations.upsertMany('CTRL', [rec({ conversation_id: 'x' })]);
  assert.deepEqual(db.conversations.list('CTRL').map((c) => c.conversation_id), ['x']);
  db.close();
});

test('каждая правка чек-листа создаёт следующую версию', () => {
  const db = openDb(':memory:');
  const a = db.checklists.create('Первый', cfg);
  const b = db.checklists.create('Второй', { ...cfg, title: 'T2' });
  assert.equal(a.id, 'v1');
  assert.equal(b.id, 'v2');
  assert.equal(db.checklists.get('v1').config.title, 'T');
  db.close();
});

test('версию чек-листа нельзя изменить или удалить на уровне БД', () => {
  const db = openDb(':memory:');
  db.checklists.create('Первый', cfg);
  assert.throws(() => db.raw.prepare("UPDATE checklist_versions SET name='x'").run(), /неизменяем/);
  assert.throws(() => db.raw.prepare('DELETE FROM checklist_versions').run(), /неизменяем/);
  db.close();
});

test('на критерий может быть только одна открытая апелляция', () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', [rec()]);
  db.checklists.create('Первый', cfg);
  const e = db.evaluations.create({ conversation_id: 'p4-ru-001', checklist_version_id: 'v1', provider: 'mock', model: 'mock' });
  db.appeals.create({ evaluation_id: e.id, criterion_id: 'c1', comment: 'a' });
  assert.throws(() => db.appeals.create({ evaluation_id: e.id, criterion_id: 'c1', comment: 'b' }), /UNIQUE/);
  db.close();
});

test('незавершённые оценки после перезапуска помечаются ошибкой', () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', [rec()]);
  db.checklists.create('Первый', cfg);
  const e = db.evaluations.create({ conversation_id: 'p4-ru-001', checklist_version_id: 'v1', provider: 'mock', model: 'mock' });
  db.evaluations.failInterrupted();
  assert.equal(db.evaluations.get(e.id).status, 'failed');
  db.close();
});
