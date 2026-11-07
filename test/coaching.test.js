import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSeedChecklist } from '../server/checklist.js';
import { buildCoachPrompt, cleanCoach } from '../server/coaching.js';
import { normalizeConversation } from '../server/normalize.js';

const checklist = loadSeedChecklist();
const normalized = normalizeConversation({
  conversation_id: 'x',
  channel: 'agent chat',
  language: 'RU',
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Почему ограничен вывод?' },
    { timestamp: '00:10', speaker: 'operator', text: 'Здравствуйте, я Руслан.' },
    { timestamp: '00:20', speaker: 'operator', text: 'Передам вопрос на проверку. До свидания.' },
  ],
});
const criterion = checklist.criteria.find((c) => c.id === 'c7');
const item = { id: 'c7', answer: 'no', explanation: 'Попрощался, не подведя итог.', evidence: [], expected_at: ['m2'] };

test('подсказка: в промпте критерий, причина потери баллов, реплика и запрет выдумывать факты', () => {
  const prompt = buildCoachPrompt({ criterion, item, normalized, kbDocs: [], clientLanguage: 'KZ' });
  assert.match(prompt.system, /c7 Завершение/);
  assert.match(prompt.system, new RegExp(criterion.definition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt.system, /Попрощался, не подведя итог\./);
  assert.match(prompt.system, /казахском/);
  assert.match(prompt.system, /не выдумывай/i);
  assert.match(prompt.user, /Место в диалоге: m2/);
  assert.match(prompt.user, /\[m2 \| operator\] Передам вопрос на проверку/);
  assert.equal(prompt.context.task, 'coach');
});

test('подсказка: пустой ответ отклоняется, неизвестная реплика заменяется местом из оценки', () => {
  assert.throws(() => cleanCoach({ msg_id: 'm2', suggestion: '  ', why: 'x' }, { normalized, target: 'm2' }), /пуст/);
  assert.throws(() => cleanCoach(null, { normalized, target: 'm2' }), /пуст/);
  assert.deepEqual(
    cleanCoach({ msg_id: 'm99', suggestion: ' Подведу итог: проверка займёт до двух дней. Чем ещё помочь? ', why: ' Итог и предложение помощи. ' }, { normalized, target: 'm2' }),
    { msg_id: 'm2', suggestion: 'Подведу итог: проверка займёт до двух дней. Чем ещё помочь?', why: 'Итог и предложение помощи.' },
  );
});
