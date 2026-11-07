import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCriterion, computeAll, round2 } from '../server/scoring.js';
import { loadSeedChecklist } from '../server/checklist.js';

const checklist = loadSeedChecklist();
const byId = (id) => checklist.criteria.find((c) => c.id === id);
const ALL_YES = { c1: 'yes', c2: 'yes', c3: 'yes', c4: 20, c5: 'yes', c6: 10, c7: 'yes', c8: 'no' };

test('«Да» даёт полный вес, «Нет» — ноль', () => {
  assert.equal(computeCriterion(byId('c3'), 'yes').score, 20);
  assert.equal(computeCriterion(byId('c3'), 'no').score, 0);
});

test('шкала пересчитывается пропорционально весу', () => {
  assert.equal(computeCriterion(byId('c4'), 15).score, 15);
  assert.equal(computeCriterion(byId('c6'), 7).score, 10.5);
});

test('верхняя ступень шкалы даёт полный вес', () => {
  assert.equal(computeCriterion(byId('c6'), 10).score, 15);
});

test('шкала с нарезкой не от нуля и в произвольном порядке считается по максимуму', () => {
  const c = { id: 'x', type: 'scale', weight: 30, scale: [3, 1, 0], na_allowed: false };
  assert.equal(computeCriterion(c, 1).score, 10);
});

test('ступень пришла строкой из ответа LLM', () => {
  assert.equal(computeCriterion(byId('c4'), '15').score, 15);
});

test('значение вне шкалы не считается ответом', () => {
  const r = computeCriterion(byId('c4'), 13);
  assert.equal(r.pending, true);
  assert.equal(r.score, null);
});

test('N/A на критерии без N/A не считается ответом', () => {
  const r = computeCriterion(byId('c1'), 'na');
  assert.equal(r.pending, true);
  assert.equal(r.applicable, true);
});

test('N/A исключает критерий из расчёта', () => {
  const r = computeCriterion(byId('c3'), 'na');
  assert.equal(r.applicable, false);
  assert.equal(r.score, null);
});

test('все ответы максимальные дают 100', () => {
  assert.equal(computeAll(checklist, ALL_YES).total, 100);
});

test('один N/A: вес перераспределяется, максимум остаётся 100', () => {
  assert.equal(computeAll(checklist, { ...ALL_YES, c3: 'na' }).total, 100);
  assert.equal(computeAll(checklist, { ...ALL_YES, c3: 'na', c1: 'no' }).total, 87.5);
});

test('пример из задания: c2 и c3 N/A, c4=15, c6=7 дают 85.38', () => {
  const answers = { c1: 'yes', c2: 'na', c3: 'na', c4: 15, c5: 'yes', c6: 7, c7: 'yes', c8: 'no' };
  assert.equal(computeAll(checklist, answers).total, 85.38);
});

test('вес после перераспределения считается от применимых', () => {
  const answers = { ...ALL_YES, c2: 'na', c3: 'na' };
  const r = computeAll(checklist, answers).criteria;
  assert.equal(r.c1.effective_weight, 15.38);
  assert.equal(r.c4.effective_weight, 30.77);
  assert.equal(r.c3.effective_weight, null);
});

test('если применимых критериев с весом нет, итог не рассчитывается', () => {
  const allNa = {
    sections: [{ id: 's', title: 'S' }],
    criteria: [{ id: 'a', section: 's', type: 'binary', weight: 10, na_allowed: true }],
  };
  assert.equal(computeAll(allNa, { a: 'na' }).total, null);
});

test('критерий с нулевым весом не влияет на итог и не делит на ноль', () => {
  const cfg = {
    sections: [{ id: 's', title: 'S' }],
    criteria: [
      { id: 'a', section: 's', type: 'binary', weight: 0, na_allowed: false },
      { id: 'b', section: 's', type: 'binary', weight: 10, na_allowed: false },
    ],
  };
  assert.equal(computeAll(cfg, { a: 'no', b: 'yes' }).total, 100);
});

test('секции считаются той же формулой по своим критериям', () => {
  const answers = { c1: 'yes', c2: 'na', c3: 'na', c4: 15, c5: 'yes', c6: 7, c7: 'yes', c8: 'no' };
  const sections = Object.fromEntries(computeAll(checklist, answers).sections.map((s) => [s.id, s.total]));
  assert.equal(sections.start, 100);
  assert.equal(sections.safety, 75);
  assert.equal(sections.conduct, 87.14);
  assert.equal(sections.gross, null);
});

test('грубая ошибка не меняет итог, но выводится флагом', () => {
  const clean = computeAll(checklist, ALL_YES);
  const flagged = computeAll(checklist, { ...ALL_YES, c8: 'yes' });
  assert.equal(flagged.total, clean.total);
  assert.equal(clean.gross_error, false);
  assert.equal(flagged.gross_error, true);
});

test('критерий без ответа не считается и помечает итог неполным', () => {
  const { c5, ...rest } = ALL_YES;
  const r = computeAll(checklist, rest);
  assert.equal(r.total, 100);
  assert.equal(r.incomplete, true);
  assert.equal(computeAll(checklist, ALL_YES).incomplete, false);
});

test('округление до двух знаков идёт вверх на границе и не страдает от двоичной погрешности', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(85.385), 85.39);
  assert.equal(round2(85.3846), 85.38);
  assert.equal(round2(1e-9), 0);
});
