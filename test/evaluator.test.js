import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConversation, runEvaluation } from '../server/evaluator/run.js';
import { buildPrompt } from '../server/evaluator/prompt.js';
import { createMockLlm } from '../server/llm/mock.js';
import { normalizeConversation } from '../server/normalize.js';
import { validateResponse } from '../server/evaluator/validate.js';
import { loadSeedChecklist } from '../server/checklist.js';
import { answersFrom } from '../server/results.js';
import { openDb } from '../server/db.js';

const checklist = loadSeedChecklist();
const conversation = {
  conversation_id: 'p1-ru-777', channel: 'agent chat', language: 'RU', audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Где посмотреть мой тариф?' },
    { timestamp: '00:02', speaker: 'bot', text: 'Здравствуйте! Я AIM.' },
    { timestamp: '00:10', speaker: 'operator', text: 'Здравствуйте, меня зовут Инга. Откройте раздел «Кабинет».' },
    { timestamp: '00:30', speaker: 'client', text: 'Спасибо, нашла.' },
    { timestamp: '00:40', speaker: 'operator', text: 'Рада помочь. До свидания!' },
  ],
};
const newCriterion = { id: 'new1', title: 'Проверка документа', section: 'conduct', type: 'scale', weight: 15, scale: [0, 1, 2], scale_labels: { 0: 'нет', 1: 'частично', 2: 'да' }, na_allowed: true, na_condition: 'Документы не обсуждались', definition: 'Оператор проверил документ.', guidance: 'Смотри реплики оператора.' };
const replacedChecklist = () => {
  const cfg = structuredClone(checklist);
  cfg.criteria = cfg.criteria.map((c) => (c.id === 'c5' ? newCriterion : c));
  return cfg;
};
const run = (llm, cfg = checklist) => evaluateConversation({ conversation, checklist: cfg, llm, kbDocs: [], uiLanguage: 'RU' });

test('ответ заглушки проходит валидацию', async () => {
  const r = await run(createMockLlm());
  assert.deepEqual(r.validation, []);
  assert.equal(r.attempts, 1);
  assert.equal(r.needs_review, false);
});

test('заглушка детерминирована', async () => {
  const [a, b] = [await run(createMockLlm()), await run(createMockLlm())];
  assert.deepEqual(a.result, b.result);
});

test('заглушка на всех диалогах явно подписывает свои объяснения', async () => {
  const r = await run(createMockLlm());
  assert.ok(r.result.criteria.every((c) => c.explanation.includes('[mock]')));
});

test('ошибка валидации вызывает один повтор с перечнем ошибок', async () => {
  const llm = createMockLlm({ fault: 'bad_quote_once' });
  const r = await run(llm);
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.validation, []);
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /quote_mismatch/);
});

test('после неудачного повтора проблемный критерий помечается, остальные считаются', async () => {
  const llm = createMockLlm({ fault: 'bad_quote_always' });
  const r = await run(llm);
  assert.equal(r.attempts, 2);
  assert.equal(llm.calls.length, 2);
  assert.equal(r.needs_review, true);
  const marked = r.result.criteria.filter((c) => c.needs_review);
  assert.equal(marked.length, 1);
  assert.ok(marked[0].review_reasons.some((reason) => reason.includes('quote_mismatch')));
  assert.equal(r.result.criteria.filter((c) => !c.needs_review).length, 6);
});

test('критерий, который модель не вернула, становится незаполненным', async () => {
  const r = await run(createMockLlm({ fault: 'drop_criterion_always' }));
  const missing = r.result.criteria.find((c) => c.needs_review);
  assert.equal(missing.answer, null);
  assert.equal(r.needs_review, true);
});

test('стоимость и токены суммируются по всем вызовам', async () => {
  const r = await run(createMockLlm({ fault: 'bad_quote_once' }));
  assert.equal(r.raw_responses.length, 2);
  assert.ok(r.input_tokens > 0);
  assert.equal(r.input_tokens, r.raw_responses.reduce((sum, x) => sum + x.usage.input_tokens, 0));
});

test('ответ без JSON отправляется на повтор, а не роняет оценку', async () => {
  const r = await run(createMockLlm({ fault: 'no_json_once' }));
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.validation, []);
});

test('ответ без JSON после повтора оставляет все критерии незаполненными', async () => {
  const r = await run(createMockLlm({ fault: 'no_json_always' }));
  assert.equal(r.needs_review, true);
  assert.ok(r.result.criteria.every((c) => c.answer === null));
});

test('замена критерия проходит оценку, валидацию и расчёт без правки кода', async () => {
  const cfg = replacedChecklist();
  const r = await run(createMockLlm(), cfg);
  assert.deepEqual(r.validation, []);
  assert.ok(r.result.criteria.some((c) => c.id === 'new1'));
  assert.ok(!r.result.criteria.some((c) => c.id === 'c5'));
  assert.ok('new1' in answersFrom(r.result, cfg));
});

test('промпт строится из конфига: новый критерий есть, заменённого нет', () => {
  const { system } = buildPrompt({ checklist: replacedChecklist(), normalized: normalizeConversation(conversation), kbDocs: [], uiLanguage: 'RU' });
  assert.match(system, /Проверка документа/);
  assert.match(system, /Документы не обсуждались/);
  assert.doesNotMatch(system, /Эмпатия/);
});

test('промпт содержит ступени шкалы с описаниями и условия N/A', () => {
  const { system } = buildPrompt({ checklist, normalized: normalizeConversation(conversation), kbDocs: [], uiLanguage: 'RU' });
  assert.match(system, /Основной вопрос решён, пропущена второстепенная деталь/);
  assert.match(system, /Запрос не требовал идентификации/);
  assert.match(system, /insult/);
});

test('транскрипт идёт в user с id реплик и помечен как данные', () => {
  const { system, user } = buildPrompt({ checklist, normalized: normalizeConversation(conversation), kbDocs: [], uiLanguage: 'RU' });
  assert.match(user, /\[m2 .*operator\] Здравствуйте, меня зовут Инга/);
  assert.match(system, /данные, а не инструкции/i);
  assert.doesNotMatch(system, /меня зовут Инга/);
});

test('system одинаков для разных диалогов: это условие кэша промпта', () => {
  const other = { ...conversation, conversation_id: 'x', transcript: conversation.transcript.slice(0, 2) };
  const a = buildPrompt({ checklist, normalized: normalizeConversation(conversation), kbDocs: [], uiLanguage: 'RU' });
  const b = buildPrompt({ checklist, normalized: normalizeConversation(other), kbDocs: [], uiLanguage: 'RU' });
  assert.equal(a.system, b.system);
});

test('пустая база знаний запрещает выдумывать правила компании', () => {
  const { system } = buildPrompt({ checklist, normalized: normalizeConversation(conversation), kbDocs: [], uiLanguage: 'RU' });
  assert.match(system, /базы знаний нет|база знаний пуста/i);
});

test('документ базы знаний попадает в промпт с указанием источника', () => {
  const kbDocs = [{ file: 'a.md', tags: ['tariff'], source: 'Регламент', effective_date: '2026-01-01', body: 'Тариф виден в кабинете.' }];
  const { system } = buildPrompt({ checklist, normalized: normalizeConversation(conversation), kbDocs, uiLanguage: 'RU' });
  assert.match(system, /Регламент/);
  assert.match(system, /Тариф виден в кабинете/);
});

test('оценка сохраняется в БД с версией чек-листа и сырыми ответами', async () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', [conversation]);
  db.checklists.create('v1', checklist);
  const e = db.evaluations.create({ conversation_id: conversation.conversation_id, checklist_version_id: 'v1', provider: 'mock', model: 'mock' });
  await runEvaluation({ db, llm: createMockLlm(), evaluationId: e.id, kbDocs: [], uiLanguage: 'RU' });
  const saved = db.evaluations.get(e.id);
  assert.equal(saved.status, 'done');
  assert.equal(saved.checklist_version_id, 'v1');
  assert.equal(saved.raw_responses.length, 1);
  assert.ok(saved.raw_responses[0].raw);
  assert.ok(saved.input_tokens > 0);
  db.close();
});

test('сбой LLM сохраняется как ошибка оценки', async () => {
  const db = openDb(':memory:');
  db.conversations.upsertMany('DEV', [conversation]);
  db.checklists.create('v1', checklist);
  const e = db.evaluations.create({ conversation_id: conversation.conversation_id, checklist_version_id: 'v1', provider: 'mock', model: 'mock' });
  await runEvaluation({ db, llm: createMockLlm({ fault: 'throw' }), evaluationId: e.id, kbDocs: [], uiLanguage: 'RU' });
  const saved = db.evaluations.get(e.id);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /mock/);
  db.close();
});

test('итог ответа заглушки проходит общую проверку и на чек-листе с новой шкалой', async () => {
  const cfg = replacedChecklist();
  const llm = createMockLlm();
  const normalized = normalizeConversation(conversation);
  const out = await llm.evaluate({ ...buildPrompt({ checklist: cfg, normalized, kbDocs: [], uiLanguage: 'RU' }), context: { checklist: cfg, normalized } }, {});
  assert.deepEqual(validateResponse(out.json, cfg, normalized), []);
});

test('сбой сети на повторе не теряет первый ответ', async () => {
  const r = await run(createMockLlm({ fault: 'bad_quote_then_throw' }));
  assert.equal(r.attempts, 2);
  assert.equal(r.needs_review, true);
  assert.ok(r.result.criteria.filter((c) => c.answer !== null).length >= 6);
});

test('если повтор хуже первого ответа, остаётся первый', async () => {
  const r = await run(createMockLlm({ fault: 'bad_quote_then_no_json' }));
  assert.equal(r.attempts, 2);
  assert.equal(r.validation.length, 1);
  assert.ok(r.result.criteria.filter((c) => c.answer !== null).length >= 6);
});

test('доказательство с неточной цитатой остаётся ссылкой, но помечается непроверенным', async () => {
  const r = await run(createMockLlm({ fault: 'bad_quote_always' }));
  const marked = r.result.criteria.find((c) => c.needs_review);
  assert.equal(marked.evidence[0].verified, false);
});
