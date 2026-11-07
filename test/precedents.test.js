import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSeedChecklist } from '../server/checklist.js';
import { openDb } from '../server/db.js';
import { buildPrompt } from '../server/evaluator/prompt.js';
import { normalizeConversation } from '../server/normalize.js';
import { collectPrecedents, sameRule } from '../server/precedents.js';

const checklist = loadSeedChecklist();

const transcript = (operatorText) => [
  { timestamp: '00:00', speaker: 'client', text: 'Почему ограничен вывод?' },
  { timestamp: '00:10', speaker: 'operator', text: 'Здравствуйте, я Руслан.' },
  { timestamp: '00:20', speaker: 'operator', text: operatorText },
];

const result = (c7) => ({
  client_language: 'RU',
  intent: 'вывод',
  criteria: checklist.criteria.filter((c) => c.type !== 'flag').map((c) => ({
    id: c.id,
    answer: c.id === 'c7' ? c7 : (c.type === 'scale' ? String(Math.max(...c.scale)) : 'yes'),
    explanation: 'x',
    evidence: [{ msg_id: 'm2', quote: 'x', verified: true }],
    expected_at: [],
    na_reason: null,
    needs_review: false,
  })),
  gross_errors: [],
});

function seed() {
  const db = openDb(':memory:');
  const version = db.checklists.create('v1', checklist);
  db.conversations.upsertMany('DEV', [
    { conversation_id: 'a', channel: 'agent chat', language: 'RU', transcript: transcript('Передам вопрос. До свидания.') },
    { conversation_id: 'b', channel: 'agent chat', language: 'RU', transcript: transcript('Чем ещё помочь?') },
    { conversation_id: 'c', channel: 'agent chat', language: 'RU', transcript: transcript('Всего доброго.') },
  ]);
  const evaluate = (conversationId) => {
    const evaluation = db.evaluations.create({ conversation_id: conversationId, checklist_version_id: version.id, provider: 'mock', model: 'm' });
    db.evaluations.finish(evaluation.id, { model: 'm', attempts: 1, result: result('yes'), validation: [], needs_review: false, raw_responses: [], input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    return evaluation.id;
  };
  const decide = (evaluationId, criterionId, action, value, reason) => {
    const appeal = db.appeals.create({ evaluation_id: evaluationId, criterion_id: criterionId, comment: 'спорно' });
    db.appeals.decide(appeal.id, { action, new_value: value, reason });
    return appeal.id;
  };
  return { db, version, evaluate, decide };
}

test('прецедент: решение «Изменить» по другому диалогу с причиной и фрагментом реплик', () => {
  const { db, evaluate, decide } = seed();
  const a = evaluate('a');
  const id = decide(a, 'c7', 'change', 'no', 'Прощание без итога не завершает диалог');
  decide(evaluate('c'), 'c5', 'confirm', null, 'Оценка верна');

  const precedents = collectPrecedents(db, { checklist, conversationId: 'b' });
  assert.equal(precedents.length, 1);
  assert.deepEqual(
    { ...precedents[0], fragment: undefined },
    { appeal_id: id, conversation_id: 'a', criterion_id: 'c7', criterion_title: 'Завершение', original: 'yes', decided: 'no', reason: 'Прощание без итога не завершает диалог', fragment: undefined },
  );
  assert.deepEqual(precedents[0].fragment, [{ id: 'm2', speaker: 'operator', text: 'Передам вопрос. До свидания.' }]);
});

test('прецедент не подставляется в тот же диалог', () => {
  const { db, evaluate, decide } = seed();
  decide(evaluate('a'), 'c7', 'change', 'no', 'причина');
  assert.deepEqual(collectPrecedents(db, { checklist, conversationId: 'a' }), []);
});

test('прецедент отбрасывается, если правило критерия с тех пор изменили', () => {
  const { db, evaluate, decide } = seed();
  decide(evaluate('a'), 'c7', 'change', 'no', 'причина');
  const changed = structuredClone(checklist);
  changed.criteria.find((c) => c.id === 'c7').definition = 'Да — оператор попрощался.';
  assert.deepEqual(collectPrecedents(db, { checklist: changed, conversationId: 'b' }), []);
  assert.equal(sameRule(checklist.criteria[0], structuredClone(checklist.criteria[0])), true);
});

test('прецеденты: сначала свежие, не больше заданного числа на критерий', () => {
  const { db, evaluate, decide } = seed();
  decide(evaluate('a'), 'c7', 'change', 'no', 'первое');
  decide(evaluate('c'), 'c7', 'change', 'no', 'второе');
  const precedents = collectPrecedents(db, { checklist, conversationId: 'b', maxPerCriterion: 1 });
  assert.deepEqual(precedents.map((p) => p.reason), ['второе']);
});

test('промпт: прецеденты добавляют раздел с причиной, без них промпт прежний', () => {
  const normalized = normalizeConversation({ conversation_id: 'b', channel: 'agent chat', language: 'RU', transcript: transcript('Чем ещё помочь?') });
  const plain = buildPrompt({ checklist, normalized, kbDocs: [], uiLanguage: 'RU' });
  assert.deepEqual(buildPrompt({ checklist, normalized, kbDocs: [], uiLanguage: 'RU', precedents: [] }), plain);

  const withPrecedents = buildPrompt({
    checklist, normalized, kbDocs: [], uiLanguage: 'RU',
    precedents: [{ appeal_id: 'x', conversation_id: 'a', criterion_id: 'c7', criterion_title: 'Завершение', original: 'yes', decided: 'no', reason: 'Прощание без итога не завершает диалог', fragment: [{ id: 'm2', speaker: 'operator', text: 'Передам вопрос. До свидания.' }] }],
  });
  assert.match(withPrecedents.system, /# Решения проверяющего по похожим случаям/);
  assert.match(withPrecedents.system, /c7 Завершение: модель ответила "yes", проверяющий изменил на "no"\. Причина: Прощание без итога не завершает диалог/);
  assert.match(withPrecedents.system, /operator: «Передам вопрос\. До свидания\.»/);
  assert.equal(withPrecedents.user, plain.user);
});
