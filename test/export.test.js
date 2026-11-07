import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSeedChecklist } from '../server/checklist.js';
import { buildRecord, buildResultsFile, exportValue, modelInfo, turnsFor, validateResultsFile } from '../server/export.js';

const checklist = loadSeedChecklist();
const byId = (id) => checklist.criteria.find((c) => c.id === id);

const conversation = {
  conversation_id: 'demo-001',
  transcript: [
    { speaker: 'client', text: 'Где тариф?' },
    { speaker: 'bot', text: 'Здравствуйте!' },
    { speaker: 'system', text: 'Эскалация' },
    { speaker: 'operator', text: 'Здравствуйте, я Алина.' },
    { speaker: 'operator', text: 'Откройте кабинет.' },
    { speaker: 'operator', text: 'Тариф под ФИО.' },
    { speaker: 'client', text: 'Спасибо' },
    { speaker: 'operator', text: 'Чем ещё помочь? До свидания!' },
  ],
};

const crit = (id, answer, over = {}) => ({
  id, answer, explanation: `объяснение ${id}`, evidence: [], expected_at: [], na_reason: null, needs_review: false, ...over,
});
const ev = (...ids) => ids.map((msg_id) => ({ msg_id, quote: 'x', verified: true }));

// Пример из приложения организаторов: c2 и c3 N/A, c4 = 15, c6 = 7 → 85.38.
const result = (over = {}) => ({
  client_language: 'RU',
  intent: 'тариф',
  criteria: [
    crit('c1', 'yes', { evidence: ev('m3') }),
    crit('c2', 'na', { explanation: '', na_reason: 'Клиент сразу ясно изложил вопрос.', evidence: ev('m0') }),
    crit('c3', 'na', { na_reason: 'Общий вопрос.' }),
    crit('c4', '15', { evidence: ev('m5', 'm4') }),
    crit('c5', 'yes', { evidence: ev('m3', 'm4') }),
    crit('c6', '7', { evidence: ev('m4'), expected_at: ['m5'] }),
    crit('c7', 'yes', { evidence: ev('m7') }),
  ],
  gross_errors: [],
  ...over,
});
const evaluation = (over = {}) => ({
  id: 'e1', conversation_id: 'demo-001', checklist_version_id: 'v1', status: 'done',
  provider: 'gemini', model: 'gemini-3.6-flash', result: result(), error: null, ...over,
});

test('в чек-листе у каждого критерия свой код для results.json', () => {
  assert.deepEqual(checklist.criteria.map((c) => c.code),
    ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical']);
});

test('значения: «Да» → true, «Нет» → false, N/A → null, шкала → число до учёта веса', () => {
  assert.equal(exportValue(byId('c1'), 'yes'), true);
  assert.equal(exportValue(byId('c1'), 'no'), false);
  assert.equal(exportValue(byId('c2'), 'na'), null);
  assert.equal(exportValue(byId('c4'), '15'), 15);
  assert.equal(exportValue(byId('c6'), '0'), 0);
  assert.equal(exportValue(byId('c8'), 'yes'), true);
});

test('номера реплик: с 1 по исходному массиву, без повторов, по возрастанию', () => {
  assert.deepEqual(turnsFor(['m5', 'm0', 'm5', 'm12']), [1, 6, 13]);
});

test('запись по примеру организаторов: восемь критериев с кодами, итог 85.38', () => {
  const record = buildRecord({ conversation, evaluation: evaluation(), checklist, appeals: [] });
  assert.equal(record.conversation_id, 'demo-001');
  assert.equal(record.status, 'ok');
  assert.deepEqual(record.criteria.map((c) => [c.criterion_id, c.value]), [
    ['contact', true], ['discovery', null], ['identification', null], ['consultation', 15],
    ['empathy', true], ['dialogue', 7], ['closure', true], ['critical', false],
  ]);
  assert.deepEqual(record.score, { final_score: 85.38, critical_flag: false });
});

test('доказательства: цитаты и место ожидания, причина N/A, без грубых — все реплики оператора', () => {
  const record = buildRecord({ conversation, evaluation: evaluation(), checklist, appeals: [] });
  const get = (code) => record.criteria.find((c) => c.criterion_id === code);
  assert.deepEqual(get('consultation').evidence_turns, [5, 6]);
  assert.deepEqual(get('dialogue').evidence_turns, [5, 6]);
  assert.equal(get('discovery').rationale, 'Клиент сразу ясно изложил вопрос.');
  assert.deepEqual(get('discovery').evidence_turns, [1]);
  assert.deepEqual(get('identification').evidence_turns, []);
  assert.deepEqual(get('critical').evidence_turns, [4, 5, 6, 8]);
  assert.match(get('critical').rationale, /не найдено/);
});

test('грубая ошибка: critical = true, флаг совпадает, итог не обнуляется', () => {
  const gross = [{ type: 'bypass', criterion_id: 'c8', msg_id: 'm4', quote: 'x', explanation: 'Предложил платную услугу.' }];
  const record = buildRecord({ conversation, evaluation: evaluation({ result: result({ gross_errors: gross }) }), checklist, appeals: [] });
  const critical = record.criteria.find((c) => c.criterion_id === 'critical');
  assert.equal(critical.value, true);
  assert.deepEqual(critical.evidence_turns, [5]);
  assert.match(critical.rationale, /платную услугу/);
  assert.deepEqual(record.score, { final_score: 85.38, critical_flag: true });
});

test('решение проверяющего попадает в выгрузку, а с original — нет', () => {
  const appeals = [{ criterion_id: 'c6', status: 'decided', action: 'change', new_value: '10', reason: 'Ответы ясные.', decided_at: '2026-11-07T10:00:00Z' }];
  const final = buildRecord({ conversation, evaluation: evaluation(), checklist, appeals });
  const dialogue = final.criteria.find((c) => c.criterion_id === 'dialogue');
  assert.equal(dialogue.value, 10);
  assert.match(dialogue.rationale, /проверяющ.*Ответы ясные/i);
  assert.notEqual(final.score.final_score, 85.38);
  const original = buildRecord({ conversation, evaluation: evaluation(), checklist, appeals, useFinal: false });
  assert.equal(original.criteria.find((c) => c.criterion_id === 'dialogue').value, 7);
});

test('не оценённый диалог: status error, пустые criteria, score null и причина', () => {
  const record = buildRecord({ conversation, evaluation: null, checklist, appeals: [] });
  assert.deepEqual(record, { conversation_id: 'demo-001', status: 'error', criteria: [], score: null, error: 'Диалог не оценён' });
});

test('упавшая оценка и критерий без ответа модели дают error, а не ноль', () => {
  const failed = buildRecord({ conversation, evaluation: evaluation({ status: 'failed', result: null, error: 'Gemini API 503' }), checklist, appeals: [] });
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /503/);
  const partial = result();
  partial.criteria[3] = crit('c4', null, { needs_review: true });
  const missing = buildRecord({ conversation, evaluation: evaluation({ result: partial }), checklist, appeals: [] });
  assert.equal(missing.status, 'error');
  assert.match(missing.error, /c4/);
});

test('модель: внешние API — external_api, локальные — local, смесь — hybrid', () => {
  assert.deepEqual(modelInfo([{ provider: 'gemini', model: 'gemini-3.6-flash' }, { provider: 'gemini', model: 'gemini-3.6-flash' }]),
    { mode: 'external_api', name: 'gemini-3.6-flash' });
  assert.deepEqual(modelInfo([{ provider: 'gemini', model: 'gemini-3.6-flash' }, { provider: 'gemini', model: 'gemini-3.5-flash-lite' }]),
    { mode: 'external_api', name: 'gemini-3.6-flash, gemini-3.5-flash-lite' });
  assert.deepEqual(modelInfo([{ provider: 'ollama', model: 'qwen3:8b' }, { provider: 'gemini', model: 'gemini-3.6-flash' }]).mode, 'hybrid');
  assert.equal(modelInfo([{ provider: 'ollama', model: 'qwen3:8b' }]).mode, 'local');
});

test('файл по образцу: версия схемы, команда, модель и результаты', () => {
  const record = buildRecord({ conversation, evaluation: evaluation(), checklist, appeals: [] });
  const file = buildResultsFile({ teamName: 'Команда', model: { mode: 'external_api', name: 'gemini-3.6-flash' }, records: [record] });
  assert.deepEqual(Object.keys(file), ['schema_version', 'team_name', 'model', 'results']);
  assert.equal(file.schema_version, '1.0');
  assert.deepEqual(validateResultsFile(file, checklist, [conversation]), []);
});

test('проверка файла ловит повтор ID, пропуск диалога, лишний критерий и неверный тип', () => {
  const record = buildRecord({ conversation, evaluation: evaluation(), checklist, appeals: [] });
  const broken = { ...structuredClone(record), conversation_id: 'demo-003' };
  broken.criteria.push({ criterion_id: 'contact', value: true, rationale: '', evidence_turns: [] });
  broken.criteria.find((c) => c.criterion_id === 'dialogue').value = 8;
  const file = buildResultsFile({ teamName: 'Команда', model: { mode: 'external_api', name: 'm' }, records: [record, record, broken] });
  const set = [conversation, { conversation_id: 'demo-002', transcript: [] }, { ...conversation, conversation_id: 'demo-003' }];
  const errors = validateResultsFile(file, checklist, set).join('\n');
  assert.match(errors, /demo-001.*повтор/);
  assert.match(errors, /demo-002.*нет в файле/);
  assert.match(errors, /contact.*2 раза/);
  assert.match(errors, /dialogue.*8/);
});

test('проверка файла: номер реплики вне диалога и несовпадение флага', () => {
  const record = buildRecord({ conversation, evaluation: evaluation(), checklist, appeals: [] });
  record.criteria.find((c) => c.criterion_id === 'contact').evidence_turns = [0, 99];
  record.score.critical_flag = true;
  const file = buildResultsFile({ teamName: 'Команда', model: { mode: 'external_api', name: 'm' }, records: [record] });
  const errors = validateResultsFile(file, checklist, [conversation]).join('\n');
  assert.match(errors, /contact.*реплик.*0, 99/);
  assert.match(errors, /critical_flag/);
});

test('сборка из БД: все диалоги набора, неоценённые — с ошибкой, mock без разрешения запрещён', async () => {
  const fs = await import('node:fs');
  const { openDb } = await import('../server/db.js');
  const { createMockLlm } = await import('../server/llm/mock.js');
  const { runBatch } = await import('../server/evaluator/batch.js');
  const { collectResults } = await import('../server/export.js');
  const { data } = JSON.parse(fs.readFileSync(new URL('../data/dev.sample.json', import.meta.url), 'utf8'));
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', data.records);
  db.checklists.create('v1', loadSeedChecklist());
  await runBatch({ db, llm: createMockLlm(), ids: ['p1-ru-001', 'p1-kz-001'], versionId: 'v1', concurrency: 1, kbDocs: [], uiLanguage: 'RU' });

  assert.throws(() => collectResults(db, { groupId: 'DEV', versionId: 'v1', teamName: 'Команда' }), /mock/);
  assert.throws(() => collectResults(db, { groupId: 'DEV', versionId: 'v1', teamName: ' ', allowMock: true }), /команды/);
  const { file, errors, summary } = collectResults(db, { groupId: 'DEV', versionId: 'v1', teamName: 'Команда', allowMock: true });
  assert.deepEqual(errors, []);
  assert.equal(file.results.length, 3);
  assert.deepEqual(file.results.map((r) => [r.conversation_id, r.status]),
    [['p1-en-001', 'error'], ['p1-kz-001', 'ok'], ['p1-ru-001', 'ok']]);
  assert.equal(summary.ok, 2);
  assert.equal(file.model.mode, 'local');
});

test('ни одного оценённого диалога: файл с ошибками всё равно собирается, модель из настроек', async () => {
  const { openDb } = await import('../server/db.js');
  const { collectResults } = await import('../server/export.js');
  const db = openDb(':memory:');
  db.conversations.upsertMany('CTRL', [{ conversation_id: 'c-1', channel: 'agent chat', language: 'RU', transcript: [{ timestamp: '00:00', speaker: 'client', text: 'Привет' }], audio_url: null }]);
  db.checklists.create('v1', loadSeedChecklist());
  const fallbackModel = { mode: 'external_api', name: 'gemini-3.6-flash' };
  const { file, errors } = collectResults(db, { groupId: 'CTRL', versionId: 'v1', teamName: 'Команда', fallbackModel });
  assert.deepEqual(errors, []);
  assert.deepEqual(file.model, fallbackModel);
  assert.equal(file.results[0].status, 'error');
});

test('версию без кодов выгрузить нельзя: сообщение называет критерий', async () => {
  const { openDb } = await import('../server/db.js');
  const { collectResults } = await import('../server/export.js');
  const db = openDb(':memory:');
  const noCodes = structuredClone(checklist);
  delete noCodes.criteria[4].code;
  db.checklists.create('v1', noCodes);
  assert.throws(() => collectResults(db, { groupId: 'DEV', versionId: 'v1', teamName: 'Команда' }), /c5: нет кода/);
});
