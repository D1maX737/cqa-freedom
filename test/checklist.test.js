import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSeedChecklist, validateChecklist, checklistWarnings, flagTypes, allowedAnswers } from '../server/checklist.js';

const seed = () => structuredClone(loadSeedChecklist());
const edited = (fn) => { const c = seed(); fn(c); return validateChecklist(c); };

test('стартовый чек-лист проходит проверку и совпадает с PDF', () => {
  const c = seed();
  assert.deepEqual(validateChecklist(c), []);
  assert.deepEqual(c.criteria.map((x) => [x.id, x.weight]), [['c1', 10], ['c2', 15], ['c3', 20], ['c4', 20], ['c5', 15], ['c6', 15], ['c7', 5], ['c8', 0]]);
  assert.deepEqual(c.criteria.map((x) => x.na_allowed), [false, true, true, true, false, false, true, false]);
  assert.deepEqual(c.criteria.find((x) => x.id === 'c4').scale, [0, 5, 10, 15, 20]);
  assert.deepEqual(c.criteria.find((x) => x.id === 'c6').scale, [0, 4, 7, 10]);
  assert.deepEqual(c.sections.map((s) => s.id), ['start', 'safety', 'conduct', 'gross']);
});

test('у каждой ступени шкалы есть описание из PDF', () => {
  for (const c of seed().criteria.filter((x) => x.type === 'scale')) {
    for (const step of c.scale) assert.ok(c.scale_labels[step], `${c.id}:${step}`);
  }
});

test('повтор id критерия отклоняется', () => {
  assert.match(edited((c) => { c.criteria[1].id = 'c1'; }).join(), /повторяется/);
});

test('секция критерия должна существовать', () => {
  assert.match(edited((c) => { c.criteria[0].section = 'nope'; }).join(), /секци/);
});

test('шкале нужны минимум две разные числовые ступени', () => {
  assert.match(edited((c) => { c.criteria[3].scale = [20]; }).join(), /ступен/);
  assert.match(edited((c) => { c.criteria[3].scale = [5, 5]; }).join(), /ступен/);
  assert.match(edited((c) => { c.criteria[3].scale = [0, 'a']; }).join(), /ступен/);
});

test('максимальная ступень шкалы должна быть больше нуля', () => {
  assert.match(edited((c) => { c.criteria[3].scale = [0, -5]; }).join(), /ступен/);
});

test('отрицательный вес отклоняется', () => {
  assert.match(edited((c) => { c.criteria[0].weight = -1; }).join(), /вес/);
});

test('у флага вес равен нулю', () => {
  assert.match(edited((c) => { c.criteria[7].weight = 5; }).join(), /флаг/i);
});

test('разрешённому N/A нужно условие', () => {
  assert.match(edited((c) => { c.criteria[1].na_condition = ''; }).join(), /N\/A/);
});

test('неизвестный тип отклоняется', () => {
  assert.match(edited((c) => { c.criteria[0].type = 'stars'; }).join(), /тип/);
});

test('сумма весов не равна 100 — предупреждение, но не ошибка', () => {
  const c = seed();
  c.criteria[0].weight = 20;
  assert.deepEqual(validateChecklist(c), []);
  assert.match(checklistWarnings(c).join(), /110/);
});

test('типы грубых ошибок берутся из конфига, а флаг без подтипов даёт свой id', () => {
  const c = seed();
  assert.deepEqual(flagTypes(c).map((t) => t.id), ['insult', 'bypass', 'disclosure']);
  c.criteria[7].subtypes = [];
  assert.deepEqual(flagTypes(c).map((t) => t.id), ['c8']);
});

test('допустимые ответы строятся из конфига критерия', () => {
  const c = seed();
  assert.deepEqual(allowedAnswers(c.criteria[0]), ['yes', 'no']);
  assert.deepEqual(allowedAnswers(c.criteria[1]), ['yes', 'no', 'na']);
  assert.deepEqual(allowedAnswers(c.criteria[3]), ['0', '5', '10', '15', '20', 'na']);
  assert.deepEqual(allowedAnswers(c.criteria[5]), ['0', '4', '7', '10']);
});

test('код для results.json необязателен, но уникален и в нижнем регистре', () => {
  const checklist = loadSeedChecklist();
  assert.deepEqual(validateChecklist(checklist), []);
  const noCode = structuredClone(checklist);
  delete noCode.criteria[0].code;
  assert.deepEqual(validateChecklist(noCode), []);
  const duplicate = structuredClone(checklist);
  duplicate.criteria[1].code = 'contact';
  assert.match(validateChecklist(duplicate).join('\n'), /код contact повторяется/);
  const bad = structuredClone(checklist);
  bad.criteria[0].code = 'Contact Code';
  assert.match(validateChecklist(bad).join('\n'), /c1: код/);
});
