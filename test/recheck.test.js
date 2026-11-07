import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConversation } from '../server/evaluator/run.js';
import { mergeRecheck, riskyCriteria } from '../server/evaluator/recheck.js';
import { loadSeedChecklist } from '../server/checklist.js';

const checklist = loadSeedChecklist();
const conversation = {
  conversation_id: 'p1-ru-778', channel: 'agent chat', language: 'RU', audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Где посмотреть мой тариф?' },
    { timestamp: '00:10', speaker: 'operator', text: 'Здравствуйте, меня зовут Инга. Откройте раздел «Кабинет».' },
    { timestamp: '00:30', speaker: 'client', text: 'Спасибо, нашла.' },
    { timestamp: '00:40', speaker: 'operator', text: 'Рада помочь. Чем ещё помочь? До свидания!' },
  ],
};

const yes = (id, msg = 'm1', quote = 'Здравствуйте, меня зовут Инга') => ({ id, answer: 'yes', explanation: 'да', evidence: [{ msg_id: msg, quote }], expected_at: [], na_reason: null, confidence: 0.9 });
const response = (over = {}) => ({
  client_language: 'RU',
  intent: 'тариф',
  criteria: [
    yes('c1'),
    { id: 'c2', answer: 'na', explanation: 'н/п', evidence: [], expected_at: [], na_reason: 'Данных хватало с самого начала.', confidence: 0.8 },
    { id: 'c3', answer: 'na', explanation: 'н/п', evidence: [], expected_at: [], na_reason: 'Вопрос общий.', confidence: 0.9 },
    { id: 'c4', answer: '20', explanation: 'полно', evidence: [{ msg_id: 'm1', quote: 'Откройте раздел «Кабинет»' }], expected_at: [], na_reason: null, confidence: 0.9 },
    yes('c5', 'm3', 'Рада помочь'),
    { id: 'c6', answer: '10', explanation: 'ясно', evidence: [{ msg_id: 'm1', quote: 'Откройте раздел «Кабинет»' }], expected_at: [], na_reason: null, confidence: 0.5 },
    { id: 'c7', answer: 'no', explanation: 'нет итога', evidence: [], expected_at: ['m3'], na_reason: null, confidence: 0.9 },
  ],
  gross_errors: [],
  ...over,
});

test('рискованные ответы: «Нет», N/A, неполная шкала, низкая уверенность; «Да» с уверенностью — нет', () => {
  const risky = riskyCriteria(response({
    criteria: [...response().criteria.filter((c) => c.id !== 'c4'), { id: 'c4', answer: '15', explanation: '', evidence: [{ msg_id: 'm1', quote: 'x' }], expected_at: [], na_reason: null, confidence: 0.9 }],
  }), checklist);
  assert.deepEqual(risky.criteria.sort(), ['c2', 'c3', 'c4', 'c6', 'c7']);
  assert.equal(risky.gross, false);
  assert.equal(riskyCriteria(response({ gross_errors: [{ type: 'rude', msg_id: 'm1', quote: 'x', explanation: 'x' }] }), checklist).gross, true);
});

test('слияние: из перепроверки берутся только рискованные критерии, грубые ошибки — только если их перепроверяли', () => {
  const first = response();
  const second = response({ criteria: response().criteria.map((c) => (c.id === 'c7' ? yes('c7', 'm3', 'Чем ещё помочь? До свидания!') : c.id === 'c1' ? { ...c, answer: 'no' } : c)), gross_errors: [{ type: 'rude' }] });
  const { merged, changed } = mergeRecheck(first, second, { criteria: ['c7'], gross: false });
  assert.equal(merged.criteria.find((c) => c.id === 'c7').answer, 'yes');
  assert.equal(merged.criteria.find((c) => c.id === 'c1').answer, 'yes');
  assert.deepEqual(merged.gross_errors, []);
  assert.deepEqual(changed, [{ id: 'c7', from: 'no', to: 'yes' }]);
});

function scriptedLlm(answers) {
  const prompts = [];
  return {
    prompts,
    name: 'scripted',
    model: 'scripted',
    async evaluate(prompt) {
      prompts.push(prompt);
      const json = answers[prompts.length - 1];
      return { json, raw: JSON.stringify(json), model: 'scripted', usage: { input_tokens: 10, output_tokens: 10 }, cost_usd: 0 };
    },
  };
}

test('перепроверка включена: второй запрос по рискованным критериям исправляет ответ и это видно в результате', async () => {
  const second = response({ criteria: response().criteria.map((c) => (c.id === 'c7' ? yes('c7', 'm3', 'Чем ещё помочь? До свидания!') : c)) });
  const llm = scriptedLlm([response(), second]);
  const out = await evaluateConversation({ conversation, checklist, llm, kbDocs: [], uiLanguage: 'RU', recheck: true });
  assert.equal(llm.prompts.length, 2);
  assert.match(llm.prompts[1].user, /<first_answer>/);
  assert.match(llm.prompts[1].user, /c7/);
  assert.equal(out.result.criteria.find((c) => c.id === 'c7').answer, 'yes');
  assert.deepEqual(out.result.recheck.changed, [{ id: 'c7', from: 'no', to: 'yes' }]);
  assert.equal(out.attempts, 2);
});

test('перепроверка выключена по умолчанию, а ответ перепроверки, который хуже первого, отбрасывается', async () => {
  const off = scriptedLlm([response()]);
  const plain = await evaluateConversation({ conversation, checklist, llm: off, kbDocs: [], uiLanguage: 'RU' });
  assert.equal(off.prompts.length, 1);
  assert.equal(plain.result.recheck, undefined);

  // Перепроверка ставит «Да» без доказательства — ответ хуже, остаётся первый.
  const broken = response({ criteria: response().criteria.map((c) => (c.id === 'c7' ? { ...c, answer: 'yes', expected_at: [] } : c)) });
  const llm = scriptedLlm([response(), broken]);
  const out = await evaluateConversation({ conversation, checklist, llm, kbDocs: [], uiLanguage: 'RU', recheck: true });
  assert.equal(out.result.criteria.find((c) => c.id === 'c7').answer, 'no');
  assert.deepEqual(out.result.recheck.changed, []);
  assert.equal(out.result.recheck.kept_first, true);
});
