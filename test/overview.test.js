import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSeedChecklist } from '../server/checklist.js';
import { computeOverview } from '../server/overview.js';
import { buildEvaluationView } from '../server/results.js';

const checklist = loadSeedChecklist();
const version = { id: 'v1', name: 'Чек-лист организаторов', config: checklist };
const full = { c1: 'yes', c2: 'yes', c3: 'yes', c4: '20', c5: 'yes', c6: '10', c7: 'yes' };

function entry(id, language, answers, { gross = [], appeals = [] } = {}) {
  const transcript = [
    { timestamp: '00:00', speaker: 'client', text: 'Вопрос' },
    { timestamp: '00:10', speaker: 'operator', text: 'Здравствуйте' },
    { timestamp: '00:20', speaker: 'operator', text: 'Ответ оператора' },
  ];
  const result = {
    client_language: language,
    intent: 'x',
    criteria: Object.entries({ ...full, ...answers }).map(([cid, answer]) => ({
      id: cid,
      answer,
      explanation: `объяснение ${cid} в ${id}`,
      evidence: answer === 'no' || answer === '0' ? [] : [{ msg_id: 'm1', quote: 'Здравствуйте', verified: true }],
      expected_at: answer === 'no' || answer === '0' || answer === '7' ? ['m2'] : [],
      na_reason: null,
      needs_review: false,
    })),
    gross_errors: gross,
  };
  const evaluation = { id: `e-${id}`, conversation_id: id, checklist_version_id: 'v1', status: 'done', provider: 'gemini', model: 'm', result };
  return {
    conversation: { conversation_id: id, language, channel: 'agent chat', transcript },
    view: buildEvaluationView(evaluation, version, appeals),
  };
}

const gross = [{ criterion_id: 'c8', type: 'disclosure', msg_id: 'm2', quote: 'Ответ оператора', explanation: 'Раскрыл данные до идентификации', verified: true }];

test('сводка: средний балл, идеальные, ниже 70 и распределение итогов', () => {
  const overview = computeOverview({
    checklist,
    entries: [entry('a', 'RU', {}), entry('b', 'RU', { c3: 'no' }), entry('c', 'KZ', { c3: 'no', c4: '0', c5: 'no' })],
  });
  assert.equal(overview.dialogs, 3);
  assert.equal(overview.perfect, 1);
  assert.equal(overview.below70, 1);
  assert.equal(overview.average, Number(((100 + 80 + 45) / 3).toFixed(2)));
  assert.deepEqual(overview.distribution.map((b) => [b.label, b.count]), [['100', 1], ['85–99', 0], ['70–84', 1], ['50–69', 0], ['ниже 50', 1]]);
});

test('сводка: где теряются баллы — по убыванию, с частотой и примером худшего случая', () => {
  const overview = computeOverview({
    checklist,
    entries: [entry('a', 'RU', {}), entry('b', 'RU', { c3: 'no' }), entry('c', 'KZ', { c3: 'no', c6: '7' })],
  });
  const [first, second] = overview.losses;
  assert.equal(first.id, 'c3');
  assert.equal(first.failed, 2);
  assert.equal(first.applicable, 3);
  assert.equal(first.average_lost, Number(((20 + 20) / 3).toFixed(2)));
  assert.deepEqual(first.example, { conversation_id: 'b', msg_id: 'm2', text: 'Ответ оператора', explanation: 'объяснение c3 в b' });
  assert.equal(second.id, 'c6');
  assert.ok(overview.losses.every((l) => l.average_lost > 0));
  const lost = overview.losses.reduce((sum, l) => sum + l.average_lost, 0);
  assert.ok(Math.abs(100 - overview.average - lost) < 0.05, `${100 - overview.average} vs ${lost}`);
});

test('сводка: грубые ошибки с репликой и объяснением, снятые по апелляции не считаются', () => {
  const appeal = { id: 'ap', evaluation_id: 'e-b', criterion_id: 'c8', status: 'decided', action: 'change', new_value: 'no', reason: 'Не нарушение', decided_at: '2026-11-08T00:00:00Z' };
  const overview = computeOverview({
    checklist,
    entries: [entry('a', 'RU', {}, { gross }), entry('b', 'RU', {}, { gross, appeals: [appeal] })],
  });
  assert.deepEqual(overview.gross, [{ conversation_id: 'a', msg_id: 'm2', explanation: 'Раскрыл данные до идентификации' }]);
});

test('сводка: языки и пять худших диалогов', () => {
  const overview = computeOverview({
    checklist,
    entries: [entry('a', 'RU', {}), entry('b', 'RU', { c3: 'no' }, { gross }), entry('c', 'KZ', { c3: 'no', c4: '0' })],
  });
  assert.deepEqual(overview.by_language.map((l) => [l.language, l.dialogs, l.average, l.gross]), [['RU', 2, 90, 1], ['KZ', 1, 60, 0]]);
  assert.deepEqual(overview.worst.map((w) => [w.conversation_id, w.total]), [['c', 60], ['b', 80], ['a', 100]]);
  assert.equal(overview.worst[1].gross, true);
});
