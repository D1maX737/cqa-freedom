import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSeedChecklist } from '../server/checklist.js';
import { computeAccuracy, consensus } from '../server/accuracy.js';
import { labelerSlug, readLabels, saveLabel, validateLabel } from '../server/labels.js';
import { computeTotal } from '../server/scoring.js';

const checklist = loadSeedChecklist();
const perfect = { c1: 'yes', c2: 'yes', c3: 'yes', c4: '20', c5: 'yes', c6: '10', c7: 'yes', c8: 'no' };

const label = (conversationId, labeler, values, extra = {}) => ({
  conversation_id: conversationId,
  labeler,
  checklist_version_id: 'v1',
  labeled_at: '2026-11-08T10:00:00.000Z',
  criteria: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value, ...extra[id] }])),
});

const conversations = [
  { conversation_id: 'p1-ru-001', language: 'RU' },
  { conversation_id: 'p1-kz-001', language: 'KZ' },
  { conversation_id: 'p1-en-001', language: 'EN' },
];

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-labels-'));

test('consensus: один размечающий задаёт эталон, расхождение людей делает ячейку спорной', () => {
  const one = consensus([label('a', 'dima', perfect)], checklist);
  assert.deepEqual(one.c4, { values: ['20'], disputed: false, labelers: 1 });

  const marked = consensus([label('a', 'dima', perfect, { c6: { disputed: true } })], checklist);
  assert.equal(marked.c6.disputed, true);

  const split = consensus([label('a', 'dima', perfect), label('a', 'sula', { ...perfect, c4: '15' })], checklist);
  assert.deepEqual(split.c4, { values: ['20', '15'], disputed: true, labelers: 2 });
  assert.equal(split.c1.disputed, false);
});

test('точность: полное совпадение по всем критериям', () => {
  const report = computeAccuracy({
    checklist,
    conversations,
    labels: [label('p1-ru-001', 'dima', perfect)],
    modelAnswers: { 'p1-ru-001': perfect },
  });
  assert.equal(report.overall.cells, 8);
  assert.equal(report.overall.matched, 8);
  assert.equal(report.overall.rate, 1);
  assert.equal(report.kappa, 1);
  assert.equal(report.total_deviation.mean, 0);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.coverage, { conversations: 3, labeled: 1, evaluated: 1, compared: 1 });
});

test('точность: расхождение попадает в критерий, список расхождений и отклонение итога', () => {
  const model = { ...perfect, c4: '15' };
  const report = computeAccuracy({
    checklist,
    conversations,
    labels: [label('p1-ru-001', 'dima', perfect)],
    modelAnswers: { 'p1-ru-001': model },
  });
  assert.equal(report.overall.matched, 7);
  const c4 = report.by_criterion.find((c) => c.id === 'c4');
  assert.deepEqual([c4.cells, c4.matched, c4.rate], [1, 0, 0]);
  assert.deepEqual(report.mismatches, [{ conversation_id: 'p1-ru-001', criterion_id: 'c4', human: ['20'], model: '15', disputed: false }]);
  const expected = Math.abs(computeTotal(checklist, model) - computeTotal(checklist, perfect));
  assert.equal(report.total_deviation.mean, Number(expected.toFixed(2)));
});

test('точность: разбивка по языкам и отдельный счёт диалогов, на которых настраивали промпт', () => {
  const report = computeAccuracy({
    checklist,
    conversations,
    labels: [label('p1-ru-001', 'dima', perfect), label('p1-kz-001', 'dima', perfect)],
    modelAnswers: { 'p1-ru-001': perfect, 'p1-kz-001': { ...perfect, c1: 'no' } },
    tuningIds: ['p1-ru-001'],
  });
  assert.deepEqual(report.by_language.map((l) => [l.language, l.cells, l.matched]), [['RU', 8, 8], ['KZ', 8, 7]]);
  assert.deepEqual([report.by_split.tuning.cells, report.by_split.tuning.matched], [8, 8]);
  assert.deepEqual([report.by_split.holdout.cells, report.by_split.holdout.matched], [8, 7]);
});

test('точность: грубые ошибки считаются отдельно — найдено, пропущено, ложные', () => {
  const report = computeAccuracy({
    checklist,
    conversations,
    labels: [
      label('p1-ru-001', 'dima', { ...perfect, c8: 'yes' }),
      label('p1-kz-001', 'dima', { ...perfect, c8: 'yes' }),
      label('p1-en-001', 'dima', perfect),
    ],
    modelAnswers: { 'p1-ru-001': { ...perfect, c8: 'yes' }, 'p1-kz-001': perfect, 'p1-en-001': { ...perfect, c8: 'yes' } },
  });
  assert.deepEqual(report.gross, { human: 2, found: 1, missed: 1, false_alarms: 1 });
});

test('точность: спорные ячейки исключаются из «без спорных», расхождение людей засчитывает любой их ответ', () => {
  const report = computeAccuracy({
    checklist,
    conversations,
    labels: [label('p1-ru-001', 'dima', perfect), label('p1-ru-001', 'sula', { ...perfect, c4: '15' })],
    modelAnswers: { 'p1-ru-001': { ...perfect, c4: '15' } },
  });
  assert.equal(report.overall.matched, 8);
  assert.deepEqual([report.clear.cells, report.clear.matched], [7, 7]);
  assert.deepEqual(report.agreement, { cells: 8, matched: 7, conversations: 1 });
});

test('точность: диалог без оценки модели не сравнивается, критерии вне чек-листа пропускаются', () => {
  const report = computeAccuracy({
    checklist,
    conversations,
    labels: [label('p1-ru-001', 'dima', { ...perfect, c99: 'yes' }), label('p1-en-001', 'dima', perfect)],
    modelAnswers: { 'p1-ru-001': perfect },
  });
  assert.equal(report.overall.cells, 8);
  assert.deepEqual(report.coverage, { conversations: 3, labeled: 2, evaluated: 1, compared: 1 });
});

test('имя размечающего становится безопасным именем файла', () => {
  assert.equal(labelerSlug('  Дима '), 'дима');
  assert.equal(labelerSlug('Sula K'), 'sula-k');
  assert.throws(() => labelerSlug(''), /имя/);
  assert.throws(() => labelerSlug('../etc'), /имя/);
});

test('разметка проверяется по чек-листу: все критерии и только допустимые значения', () => {
  assert.deepEqual(validateLabel({ criteria: Object.fromEntries(Object.entries(perfect).map(([k, v]) => [k, { value: v }])) }, checklist), []);
  const errors = validateLabel({ criteria: { c1: { value: 'na' }, c6: { value: '5' } } }, checklist);
  assert.ok(errors.some((e) => e.startsWith('c1')), errors.join('; '));
  assert.ok(errors.some((e) => e.startsWith('c6')), errors.join('; '));
  assert.ok(errors.some((e) => e.startsWith('c8')), errors.join('; '));
});

test('разметка сохраняется в файл размечающего и читается обратно, повтор перезаписывает', () => {
  const dir = tmpDir();
  assert.deepEqual(readLabels(dir), []);
  const criteria = Object.fromEntries(Object.entries(perfect).map(([k, v]) => [k, { value: v }]));
  saveLabel(dir, 'Дима', 'p1-ru-001', { checklist_version_id: 'v1', criteria });
  saveLabel(dir, 'Дима', 'p1-ru-001', { checklist_version_id: 'v1', criteria: { ...criteria, c4: { value: '15', note: 'частично' } } });
  saveLabel(dir, 'Sula', 'p1-kz-001', { checklist_version_id: 'v1', criteria });

  assert.deepEqual(fs.readdirSync(dir).sort(), ['sula.json', 'дима.json']);
  const labels = readLabels(dir);
  assert.equal(labels.length, 2);
  const mine = labels.find((l) => l.labeler === 'дима');
  assert.equal(mine.conversation_id, 'p1-ru-001');
  assert.deepEqual(mine.criteria.c4, { value: '15', note: 'частично' });
  assert.ok(mine.labeled_at);
});

test('доверительный интервал: бутстрэп по диалогам, детерминирован и содержит точечную оценку', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ conversation_id: `d${i}`, language: 'RU' }));
  const labels = many.map((c) => label(c.conversation_id, 'dima', perfect));
  // В каждом третьем диалоге модель ошиблась в одном критерии.
  const modelAnswers = Object.fromEntries(many.map((c, i) => [c.conversation_id, i % 3 === 0 ? { ...perfect, c4: '15' } : perfect]));
  const a = computeAccuracy({ checklist, conversations: many, labels, modelAnswers });
  const b = computeAccuracy({ checklist, conversations: many, labels, modelAnswers });
  assert.deepEqual(a.overall.ci, b.overall.ci);
  const [low, high] = a.overall.ci;
  assert.ok(low <= a.overall.rate && a.overall.rate <= high, `${low} ≤ ${a.overall.rate} ≤ ${high}`);
  assert.ok(low > 0.9 && high <= 1 && high > low, `${low}–${high}`);
  assert.equal(a.clear.ci.length, 2);
});

test('доверительный интервал при полном совпадении — точка, без сравнения — нет интервала', () => {
  const full = computeAccuracy({ checklist, conversations, labels: [label('p1-ru-001', 'dima', perfect)], modelAnswers: { 'p1-ru-001': perfect } });
  assert.deepEqual(full.overall.ci, [1, 1]);
  const none = computeAccuracy({ checklist, conversations, labels: [], modelAnswers: {} });
  assert.equal(none.overall.ci, null);
});
