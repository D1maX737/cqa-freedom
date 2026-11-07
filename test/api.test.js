import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createMockLlm } from '../server/llm/mock.js';
import { loadSeedChecklist } from '../server/checklist.js';

const sample = JSON.parse(fs.readFileSync(new URL('../data/dev.sample.json', import.meta.url), 'utf8'));

async function start(over = {}) {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    settings: { llmProvider: 'mock', llmConcurrency: 2, uiLanguage: 'RU', audioHostSuffix: '.powerplatform.com', datasetUrl: '', ...over.settings },
    createLlm: over.createLlm ?? (async () => createMockLlm()),
    kbDocs: [],
    fetchImpl: over.fetchImpl,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method, redirect: 'manual',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    return { status: response.status, body: isJson && text ? JSON.parse(text) : null, headers: response.headers };
  };
  return { db, app, call, close: () => new Promise((resolve) => { server.close(resolve); }) };
}

async function evaluated(ctx, ids = ['p1-ru-001'], version = 'v1') {
  const r = await ctx.call('POST', '/evaluations', { conversation_ids: ids, checklist_version_id: version });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await ctx.app.locals.queue.idle();
  return r.body.evaluations.map((e) => e.id);
}

test('чек-лист v1 создаётся при первом запуске из конфига', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const r = await ctx.call('GET', '/checklists');
  assert.deepEqual(r.body.map((c) => c.id), ['v1']);
  assert.equal(r.body[0].total_weight, 100);
});

test('импорт диалогов и список с фильтрами', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const imported = await ctx.call('POST', '/conversations/import?group=DEV', sample);
  assert.equal(imported.body.imported, 3);
  assert.equal((await ctx.call('GET', '/conversations?group=DEV')).body.length, 3);
  assert.deepEqual((await ctx.call('GET', '/conversations?group=DEV&language=KZ')).body.map((c) => c.conversation_id), ['p1-kz-001']);
  assert.equal((await ctx.call('GET', '/conversations?channel=voice%20call')).body.length, 0);
});

test('импорт отклоняет некорректный файл с понятной ошибкой', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const r = await ctx.call('POST', '/conversations/import', { records: [{ conversation_id: 'x', channel: 'agent chat', language: 'RU', transcript: 'нет' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /transcript/);
});

test('карточка диалога отдаёт реплики с id и факты', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const r = await ctx.call('GET', '/conversations/p1-ru-001');
  assert.equal(r.body.conversation.messages[0].id, 'm0');
  assert.equal(r.body.conversation.messages[0].timestamp, sample.data.records[0].transcript[0].timestamp);
  assert.ok(r.body.conversation.facts.first_operator_msg);
});

test('неизвестный диалог даёт 404', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  assert.equal((await ctx.call('GET', '/conversations/nope')).status, 404);
});

test('оценка выполняется в фоне и попадает в список с итогом', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx);
  const view = (await ctx.call('GET', `/evaluations/${id}`)).body;
  assert.equal(view.status, 'done');
  assert.equal(view.checklist_version_id, 'v1');
  assert.equal(typeof view.original.scores.total, 'number');
  assert.equal(view.criteria.length, 8);
  const row = (await ctx.call('GET', '/conversations?group=DEV')).body.find((c) => c.conversation_id === 'p1-ru-001');
  assert.equal(row.evaluation.total_final, view.final.scores.total);
});

test('оценка без выбранных диалогов или с неизвестной версией отклоняется', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  assert.equal((await ctx.call('POST', '/evaluations', { conversation_ids: [], checklist_version_id: 'v1' })).status, 400);
  assert.equal((await ctx.call('POST', '/evaluations', { conversation_ids: ['p1-ru-001'], checklist_version_id: 'v9' })).status, 400);
  assert.equal((await ctx.call('POST', '/evaluations', { conversation_ids: ['nope'], checklist_version_id: 'v1' })).status, 400);
});

test('без ключа провайдера оценка не запускается и не создаёт пустых записей', async (t) => {
  const ctx = await start({ createLlm: async () => { throw new Error('Для LLM_PROVIDER=anthropic нужен ANTHROPIC_API_KEY в .env'); } });
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const r = await ctx.call('POST', '/evaluations', { conversation_ids: ['p1-ru-001'], checklist_version_id: 'v1' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ANTHROPIC_API_KEY/);
  assert.equal(ctx.db.evaluations.listFor('p1-ru-001').length, 0);
});

test('апелляция и решение «Изменить» пересчитывают итог без вызова LLM', async (t) => {
  let llmCalls = 0;
  const ctx = await start({ createLlm: async () => { const llm = createMockLlm(); const original = llm.evaluate; llm.evaluate = (...a) => { llmCalls += 1; return original(...a); }; return llm; } });
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx);
  const before = (await ctx.call('GET', `/evaluations/${id}`)).body;
  const target = before.criteria.find((c) => c.type === 'binary' && c.final.answer !== null && c.weight > 0);
  const flipped = target.final.answer === 'yes' ? 'no' : 'yes';

  const appeal = await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: target.id, comment: 'Оператор представился' });
  assert.equal(appeal.status, 201);
  const queue = (await ctx.call('GET', '/appeals?status=open')).body;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].comment, 'Оператор представился');
  assert.equal(queue[0].criterion.id, target.id);
  assert.ok(queue[0].fragment.length > 0);

  const callsBefore = llmCalls;
  const decided = await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'change', new_value: flipped, reason: 'Проверил транскрипт' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(llmCalls, callsBefore);
  const after = decided.body.evaluation;
  const row = after.criteria.find((c) => c.id === target.id);
  assert.equal(row.original.answer, target.final.answer);
  assert.equal(row.final.answer, flipped);
  assert.equal(row.appeal.reason, 'Проверил транскрипт');
  assert.equal(after.original.scores.total, before.original.scores.total);
  assert.notEqual(after.final.scores.total, before.final.scores.total);
  assert.equal((await ctx.call('GET', '/appeals?status=open')).body.length, 0);
});

test('решение «Подтвердить» сохраняет оценку и причину', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx);
  const appeal = await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'c1', comment: 'не согласен' });
  const r = await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'confirm', reason: 'Оценка верна' });
  assert.equal(r.status, 200);
  assert.equal(r.body.evaluation.final.scores.total, r.body.evaluation.original.scores.total);
  assert.equal(r.body.evaluation.criteria.find((c) => c.id === 'c1').appeal.action, 'confirm');
});

test('решение без причины и с недопустимым значением отклоняется', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx);
  const appeal = await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'c4', comment: 'x' });
  assert.equal((await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'confirm', reason: ' ' })).status, 400);
  assert.equal((await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'change', new_value: '13', reason: 'x' })).status, 400);
  assert.equal((await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'change', new_value: 'na', reason: 'x' })).status, 200);
});

test('повторное решение по закрытой апелляции отклоняется', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx);
  const appeal = await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'c1', comment: 'x' });
  await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'confirm', reason: 'ok' });
  assert.equal((await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'confirm', reason: 'ok' })).status, 409);
});

test('апелляция: пустой комментарий, неизвестный критерий и повтор отклоняются', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx);
  assert.equal((await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'c1', comment: '' })).status, 400);
  assert.equal((await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'zz', comment: 'x' })).status, 400);
  assert.equal((await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'c1', comment: 'x' })).status, 201);
  assert.equal((await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'c1', comment: 'x' })).status, 409);
});

test('грубую ошибку можно оспорить и снять', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx);
  const appeal = await ctx.call('POST', '/appeals', { evaluation_id: id, criterion_id: 'c8', comment: 'x' });
  const r = await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'change', new_value: 'yes', reason: 'есть оскорбление' });
  assert.equal(r.body.evaluation.final.scores.gross_error, true);
});

test('новая версия чек-листа с заменой критерия применяется без правки кода', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const config = loadSeedChecklist();
  config.criteria = config.criteria.map((c) => (c.id !== 'c5' ? c : {
    id: 'c9', title: 'Проверка документов', section: 'conduct', type: 'scale', weight: 15, scale: [0, 5, 10],
    scale_labels: { 0: 'нет', 5: 'частично', 10: 'да' }, na_allowed: true, na_condition: 'Документы не обсуждались', definition: 'Оператор проверил документы.', guidance: '',
  }));
  const created = await ctx.call('POST', '/checklists', { name: 'Замена c5 на c9', config });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.id, 'v2');
  const [id] = await evaluated(ctx, ['p1-ru-001', 'p1-en-001'], 'v2');
  const view = (await ctx.call('GET', `/evaluations/${id}`)).body;
  assert.ok(view.criteria.some((c) => c.id === 'c9'));
  assert.ok(!view.criteria.some((c) => c.id === 'c5'));
  assert.deepEqual((await ctx.call('GET', '/checklists/v1')).body.config.criteria.map((c) => c.id).includes('c5'), true);
});

test('некорректный чек-лист не сохраняется', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const config = loadSeedChecklist();
  config.criteria[1].id = 'c1';
  const r = await ctx.call('POST', '/checklists', { name: 'x', config });
  assert.equal(r.status, 400);
  assert.match(r.body.errors.join(), /повторяется/);
  assert.equal((await ctx.call('GET', '/checklists')).body.length, 1);
});

test('запись звонка открывается по свежей ссылке через редирект', async (t) => {
  const fetchImpl = async () => new Response('<source src="https://a.dynamics.com/fresh.mp3">', { headers: { 'content-type': 'text/html' } });
  const ctx = await start({ fetchImpl });
  t.after(ctx.close);
  const call = { conversation_id: 'p4-ru-9', channel: 'voice call', language: 'RU', audio_url: 'https://x.api.powerplatform.com/rec', transcript: [{ timestamp: '2026-11-03T15:49:13.1900670+00:00', speaker: 'client', text: 'Алло' }] };
  await ctx.call('POST', '/conversations/import', [call]);
  const r = await ctx.call('GET', '/conversations/p4-ru-9/audio');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://a.dynamics.com/fresh.mp3');
  assert.equal((await ctx.call('GET', '/conversations/p1-ru-001/audio')).status, 404);
});

test('загрузка набора без DATASET_URL даёт понятную ошибку', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const r = await ctx.call('POST', '/datasets/DEV/fetch');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /DATASET_URL/);
});

test('разметка эталона: сохраняется в файл размечающего и сравнивается с исходной оценкой модели', async (t) => {
  const labelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-api-labels-'));
  const ctx = await start({ settings: { labelsDir, tuningIds: ['p1-ru-001'] } });
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [id] = await evaluated(ctx, ['p1-ru-001']);
  const { answers } = (await ctx.call('GET', `/evaluations/${id}`)).body.original;
  const criteria = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { value: v }]));

  const saved = await ctx.call('PUT', '/labels/p1-ru-001', { labeler: 'Дима', checklist_version_id: 'v1', criteria });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(fs.existsSync(path.join(labelsDir, 'дима.json')));
  assert.equal((await ctx.call('GET', '/labels')).body.labels.length, 1);

  // Заглушка — не модель: без явного разрешения её оценки в точность не попадают.
  const skipped = (await ctx.call('GET', '/accuracy?group=DEV&version=v1')).body;
  assert.equal(skipped.coverage.compared, 0);
  assert.equal(skipped.mock_skipped, 1);

  const report = (await ctx.call('GET', '/accuracy?group=DEV&version=v1&allow_mock=1')).body;
  assert.deepEqual(report.coverage, { conversations: 3, labeled: 1, evaluated: 1, compared: 1 });
  assert.equal(report.overall.rate, 1);
  assert.equal(report.by_split.tuning.cells, 8);
  assert.equal(report.checklist_version_id, 'v1');
});

test('разметка отклоняется без имени, с пропуском критерия и для неизвестного диалога', async (t) => {
  const labelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-api-labels-'));
  const ctx = await start({ settings: { labelsDir } });
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const criteria = { c1: { value: 'yes' } };
  const noName = await ctx.call('PUT', '/labels/p1-ru-001', { labeler: '', checklist_version_id: 'v1', criteria });
  assert.equal(noName.status, 400);
  const partial = await ctx.call('PUT', '/labels/p1-ru-001', { labeler: 'dima', checklist_version_id: 'v1', criteria });
  assert.equal(partial.status, 400);
  assert.match(partial.body.error, /c8/);
  assert.equal((await ctx.call('PUT', '/labels/nope', { labeler: 'dima', checklist_version_id: 'v1', criteria })).status, 404);
  assert.deepEqual(fs.readdirSync(labelsDir), []);
});

test('решение по апелляции становится прецедентом в промпте других диалогов, но не того же', async (t) => {
  const prompts = [];
  const ctx = await start({
    createLlm: async () => {
      const llm = createMockLlm();
      const original = llm.evaluate;
      llm.evaluate = (prompt, schema) => { prompts.push(prompt); return original(prompt, schema); };
      return llm;
    },
  });
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [first] = await evaluated(ctx, ['p1-ru-001']);
  const before = (await ctx.call('GET', `/evaluations/${first}`)).body;
  const target = before.criteria.find((c) => c.type === 'binary' && c.final.answer !== null);
  const flipped = target.final.answer === 'yes' ? 'no' : 'yes';
  const appeal = await ctx.call('POST', '/appeals', { evaluation_id: first, criterion_id: target.id, comment: 'Спорно' });
  await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'change', new_value: flipped, reason: 'Толкование проверяющего для прецедента' });

  prompts.length = 0;
  const [other] = await evaluated(ctx, ['p1-kz-001']);
  assert.match(prompts[0].system, /Толкование проверяющего для прецедента/);
  const view = (await ctx.call('GET', `/evaluations/${other}`)).body;
  assert.deepEqual(view.precedents, [{ appeal_id: appeal.body.id, conversation_id: 'p1-ru-001', criterion_id: target.id }]);

  prompts.length = 0;
  await evaluated(ctx, ['p1-ru-001']);
  assert.doesNotMatch(prompts[0].system, /Толкование проверяющего/);
});

test('прецеденты можно выключить настройкой', async (t) => {
  const prompts = [];
  const ctx = await start({
    settings: { usePrecedents: false },
    createLlm: async () => {
      const llm = createMockLlm();
      const original = llm.evaluate;
      llm.evaluate = (prompt, schema) => { prompts.push(prompt); return original(prompt, schema); };
      return llm;
    },
  });
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const [first] = await evaluated(ctx, ['p1-ru-001']);
  const target = (await ctx.call('GET', `/evaluations/${first}`)).body.criteria.find((c) => c.type === 'binary' && c.final.answer !== null);
  const appeal = await ctx.call('POST', '/appeals', { evaluation_id: first, criterion_id: target.id, comment: 'Спорно' });
  await ctx.call('POST', `/appeals/${appeal.body.id}/decision`, { action: 'change', new_value: target.final.answer === 'yes' ? 'no' : 'yes', reason: 'Не должно попасть в промпт' });
  prompts.length = 0;
  await evaluated(ctx, ['p1-kz-001']);
  assert.doesNotMatch(prompts[0].system, /Не должно попасть в промпт/);
});

test('сводка по набору: оценки заглушкой не в счёт без явного разрешения', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  await evaluated(ctx, ['p1-ru-001', 'p1-kz-001']);
  const skipped = (await ctx.call('GET', '/overview?group=DEV')).body;
  assert.equal(skipped.dialogs, 0);
  assert.equal(skipped.mock_skipped, 2);
  const overview = (await ctx.call('GET', '/overview?group=DEV&allow_mock=1')).body;
  assert.equal(overview.dialogs, 2);
  assert.equal(overview.conversations, 3);
  assert.equal(overview.checklist_version_id, 'v1');
  assert.deepEqual(overview.by_language.map((l) => l.language).sort(), ['KZ', 'RU']);
});

async function lossAndFull(ctx) {
  const ids = await evaluated(ctx, ['p1-ru-001', 'p1-kz-001', 'p1-en-001']);
  const views = await Promise.all(ids.map(async (id) => (await ctx.call('GET', `/evaluations/${id}`)).body));
  const scored = (c) => c.type !== 'flag' && c.final.effective_weight !== null;
  const loss = views.flatMap((v) => v.criteria.filter((c) => scored(c) && c.final.effective_score < c.final.effective_weight).map((c) => [v.id, c.id]))[0];
  const full = views.flatMap((v) => v.criteria.filter((c) => scored(c) && c.final.effective_score === c.final.effective_weight).map((c) => [v.id, c.id]))[0];
  return { loss, full };
}

test('«Как надо было ответить»: подсказка по невыполненному критерию сохраняется и не запрашивается повторно', async (t) => {
  let calls = 0;
  const ctx = await start({ createLlm: async () => { const llm = createMockLlm(); const original = llm.evaluate; llm.evaluate = (...a) => { calls += 1; return original(...a); }; return llm; } });
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const { loss } = await lossAndFull(ctx);
  assert.ok(loss, 'в выборке есть невыполненный критерий');
  const [evaluationId, criterionId] = loss;
  const before = calls;
  const first = await ctx.call('POST', `/evaluations/${evaluationId}/coaching`, { criterion_id: criterionId });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.ok(first.body.suggestion.length > 0);
  assert.equal(first.body.criterion_id, criterionId);
  const again = await ctx.call('POST', `/evaluations/${evaluationId}/coaching`, { criterion_id: criterionId });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.equal(calls, before + 1);
  const view = (await ctx.call('GET', `/evaluations/${evaluationId}`)).body;
  assert.deepEqual(view.coaching.map((c) => c.criterion_id), [criterionId]);
});

test('«Как надо было ответить»: не нужна для выполненного критерия и грубой ошибки, неизвестная оценка — 404', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  await ctx.call('POST', '/conversations/import?group=DEV', sample);
  const { full } = await lossAndFull(ctx);
  const done = await ctx.call('POST', `/evaluations/${full[0]}/coaching`, { criterion_id: full[1] });
  assert.equal(done.status, 400);
  assert.match(done.body.error, /выполнен/);
  assert.equal((await ctx.call('POST', `/evaluations/${full[0]}/coaching`, { criterion_id: 'c8' })).status, 400);
  assert.equal((await ctx.call('POST', '/evaluations/nope/coaching', { criterion_id: 'c1' })).status, 404);
});

test('свой диалог текстом добавляется в набор OWN и оценивается как обычный', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const text = '00:00 клиент: Не могу вывести деньги\n00:20 оператор: Здравствуйте, меня зовут Алия. Какое сообщение вы видите?\n00:40 клиент: Ошибка 403';
  const added = await ctx.call('POST', '/conversations/paste', { text });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.group, 'OWN');
  assert.equal(added.body.language, 'RU');
  assert.equal(added.body.turns, 3);
  const id = added.body.conversation_id;
  assert.match(id, /^own-/);
  assert.equal((await ctx.call('GET', `/conversations/${id}`)).body.conversation.messages[1].speaker, 'operator');
  const [evaluationId] = await evaluated(ctx, [id]);
  assert.equal((await ctx.call('GET', `/evaluations/${evaluationId}`)).body.status, 'done');

  const bad = await ctx.call('POST', '/conversations/paste', { text: 'просто текст' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /оператор: текст/);
});
