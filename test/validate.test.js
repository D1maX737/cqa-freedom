import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResponse, normalizeForMatch, problemCriteria } from '../server/evaluator/validate.js';
import { buildResponseSchema } from '../server/evaluator/schema.js';
import { loadSeedChecklist } from '../server/checklist.js';

const checklist = loadSeedChecklist();
const normalized = {
  messages: [
    { id: 'm0', speaker: 'client', text: 'Где мой  тариф?' },
    { id: 'm1', speaker: 'bot', text: 'Здравствуйте!' },
    { id: 'm2', speaker: 'system', text: 'Личность клиента подтверждена.' },
    { id: 'm3', speaker: 'operator', text: 'Здравствуйте, меня зовут Инга. Откройте отчёт.' },
    { id: 'm4', speaker: 'client', text: 'Спасибо' },
    { id: 'm5', speaker: 'operator', text: 'До свидания!' },
  ],
};
const ev = (id = 'm3', quote = 'меня зовут Инга') => [{ msg_id: id, quote }];
const yes = (id) => ({ id, answer: 'yes', explanation: 'ok', evidence: ev(), expected_at: [], na_reason: null, confidence: 0.9 });

const good = () => ({
  client_language: 'RU',
  intent: 'Узнать тариф',
  criteria: [
    yes('c1'), yes('c2'),
    { ...yes('c3'), evidence: ev('m2', 'Личность клиента подтверждена') },
    { ...yes('c4'), answer: '15' }, yes('c5'), { ...yes('c6'), answer: '10' }, yes('c7'),
  ],
  gross_errors: [],
});
const codes = (response, cfg = checklist) => validateResponse(response, cfg, normalized).map((e) => e.code);
const withCriterion = (id, patch) => {
  const r = good();
  Object.assign(r.criteria.find((c) => c.id === id), patch);
  return r;
};

test('корректный ответ проходит без ошибок', () => {
  assert.deepEqual(codes(good()), []);
});

test('ответ не объект', () => {
  assert.deepEqual(codes(null), ['invalid_format']);
});

test('несуществующий msg_id в доказательстве', () => {
  assert.deepEqual(codes(withCriterion('c1', { evidence: ev('m99') })), ['unknown_msg']);
});

test('цитаты нет в реплике', () => {
  assert.deepEqual(codes(withCriterion('c1', { evidence: ev('m3', 'такого не было') })), ['quote_mismatch']);
});

test('цитата сверяется без учёта регистра и лишних пробелов', () => {
  assert.deepEqual(codes(withCriterion('c1', { evidence: ev('m0', 'ГДЕ МОЙ ТАРИФ') })), []);
});

test('пустая цитата не считается доказательством', () => {
  assert.deepEqual(codes(withCriterion('c1', { evidence: ev('m3', '   ') })), ['quote_mismatch']);
});

test('ответ не из допустимых для критерия', () => {
  assert.deepEqual(codes(withCriterion('c1', { answer: '5' })), ['invalid_answer']);
  assert.deepEqual(codes(withCriterion('c4', { answer: '13' })), ['invalid_answer']);
});

test('числовая ступень принимается наравне со строкой', () => {
  assert.deepEqual(codes(withCriterion('c4', { answer: 15 })), []);
});

test('«Да» без доказательства', () => {
  assert.deepEqual(codes(withCriterion('c1', { evidence: [] })), ['missing_evidence']);
});

test('шкала выше нуля без доказательства', () => {
  assert.deepEqual(codes(withCriterion('c4', { answer: '5', evidence: [] })), ['missing_evidence']);
});

test('«Нет» без места ожидания', () => {
  assert.deepEqual(codes(withCriterion('c1', { answer: 'no', evidence: [], expected_at: [] })), ['missing_expected']);
});

test('«Нет» с указанием места проходит', () => {
  assert.deepEqual(codes(withCriterion('c1', { answer: 'no', evidence: [], expected_at: ['m3'] })), []);
});

test('шкала 0 тоже требует указать, где ожидалось действие', () => {
  assert.deepEqual(codes(withCriterion('c4', { answer: '0', evidence: [], expected_at: [] })), ['missing_expected']);
});

test('expected_at со ссылкой на несуществующую реплику', () => {
  assert.deepEqual(codes(withCriterion('c1', { answer: 'no', evidence: [], expected_at: ['m99'] })), ['unknown_msg']);
});

test('N/A там, где он запрещён', () => {
  assert.deepEqual(codes(withCriterion('c1', { answer: 'na', evidence: [], na_reason: 'x' })), ['invalid_answer']);
});

test('N/A без причины', () => {
  assert.deepEqual(codes(withCriterion('c3', { answer: 'na', evidence: [], na_reason: ' ' })), ['missing_na_reason']);
});

test('N/A с причиной проходит и не требует доказательства', () => {
  assert.deepEqual(codes(withCriterion('c3', { answer: 'na', evidence: [], na_reason: 'Запрос не требовал идентификации' })), []);
});

test('пропущен критерий с весом', () => {
  const r = good();
  r.criteria = r.criteria.filter((c) => c.id !== 'c5');
  assert.deepEqual(codes(r), ['missing_criterion']);
});

test('флаг не обязан присутствовать в criteria', () => {
  assert.ok(!good().criteria.some((c) => c.id === 'c8'));
  assert.deepEqual(codes(good()), []);
});

test('неизвестный критерий', () => {
  const r = good();
  r.criteria.push(yes('zzz'));
  assert.deepEqual(codes(r), ['unknown_criterion']);
});

test('критерий повторён дважды', () => {
  const r = good();
  r.criteria.push(yes('c1'));
  assert.deepEqual(codes(r), ['duplicate_criterion']);
});

const withGross = (patch) => ({ ...good(), gross_errors: [{ type: 'insult', msg_id: 'm3', quote: 'меня зовут Инга', explanation: 'x', ...patch }] });

test('грубая ошибка оператора с точной цитатой проходит', () => {
  assert.deepEqual(codes(withGross({})), []);
});

test('тип грубой ошибки берётся из конфига', () => {
  assert.deepEqual(codes(withGross({ type: 'spam' })), ['invalid_gross_type']);
});

test('грубую ошибку можно приписать только оператору', () => {
  assert.deepEqual(codes(withGross({ msg_id: 'm0', quote: 'Где мой тариф' })), ['gross_not_operator']);
});

test('цитата грубой ошибки тоже сверяется', () => {
  assert.deepEqual(codes(withGross({ quote: 'ты идиот' })), ['quote_mismatch']);
});

test('новый критерий из конфига проверяется без правки кода', () => {
  const cfg = structuredClone(checklist);
  cfg.criteria = cfg.criteria.filter((c) => c.id !== 'c5');
  cfg.criteria.push({ id: 'new1', title: 'Новый', section: 'conduct', type: 'scale', weight: 15, scale: [0, 1, 2], na_allowed: false, na_condition: '', definition: 'd', guidance: '' });
  const r = good();
  r.criteria = r.criteria.filter((c) => c.id !== 'c5');
  r.criteria.push({ ...yes('new1'), answer: '2' });
  assert.deepEqual(codes(r, cfg), []);
  r.criteria.at(-1).answer = '3';
  assert.deepEqual(codes(r, cfg), ['invalid_answer']);
});

test('список проблемных критериев строится из ошибок', () => {
  const errors = validateResponse(withCriterion('c1', { evidence: ev('m99') }), checklist, normalized);
  assert.deepEqual([...problemCriteria(errors).keys()], ['c1']);
});

test('нормализация сверки схлопывает пробелы и регистр', () => {
  assert.equal(normalizeForMatch('  А\n Б\tв '), 'а б в');
});

test('схема ответа собирается из конфига', () => {
  const schema = buildResponseSchema(checklist);
  const item = schema.properties.criteria.items.properties;
  assert.deepEqual(item.id.enum, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  assert.ok(item.answer.enum.includes('yes') && item.answer.enum.includes('na') && item.answer.enum.includes('20'));
  assert.deepEqual(schema.properties.gross_errors.items.properties.type.enum, ['insult', 'bypass', 'disclosure']);
});

test('схема без флагов не содержит пустого enum', () => {
  const cfg = structuredClone(checklist);
  cfg.criteria = cfg.criteria.filter((c) => c.type !== 'flag');
  assert.equal(buildResponseSchema(cfg).properties.gross_errors.items.properties.type.enum, undefined);
});
