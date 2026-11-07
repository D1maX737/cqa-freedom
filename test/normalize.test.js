import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeConversation, detectClientLanguage, parseChatTime } from '../server/normalize.js';

const chat = (turns, over = {}) => ({
  conversation_id: 't', channel: 'agent chat', language: 'RU', audio_url: null,
  transcript: turns.map(([timestamp, speaker, text]) => ({ timestamp, speaker, text })),
  ...over,
});
const call = (turns) => chat(turns.map(([sec, speaker, text]) => [new Date(Date.UTC(2026, 10, 3, 15, 0, sec)).toISOString().replace('Z', '0000+00:00'), speaker, text]), { channel: 'voice call', audio_url: 'https://x/a' });

test('реплики нумеруются m0..mN, исходный timestamp не меняется', () => {
  const n = normalizeConversation(chat([['00:00', 'client', 'Да'], ['00:05', 'bot', 'Нет']]));
  assert.deepEqual(n.messages.map((m) => m.id), ['m0', 'm1']);
  assert.equal(n.messages[1].timestamp, '00:05');
});

test('время чата разбирается и за пределами часа', () => {
  assert.equal(parseChatTime('01:05'), 65);
  assert.equal(parseChatTime('62:10'), 3730);
});

test('время звонка отсчитывается от первого события', () => {
  const n = normalizeConversation(call([[10, 'system', 'a'], [25, 'client', 'b']]));
  assert.equal(n.messages[1].t_sec, 15);
});

test('семизначные доли секунды в ISO разбираются', () => {
  const n = normalizeConversation(chat([
    ['2026-11-03T15:49:13.1900670+00:00', 'system', 'a'],
    ['2026-11-03T15:49:15.1900670+00:00', 'client', 'b'],
  ], { channel: 'voice call' }));
  assert.equal(n.messages[1].t_sec, 2);
});

test('язык клиента: русский, казахский и английский', () => {
  assert.equal(detectClientLanguage(['Где посмотреть мой тариф?', 'Хорошо, спасибо большое']).value, 'RU');
  assert.equal(detectClientLanguage(['Тарифімді қайдан көруге болады?']).value, 'KZ');
  assert.equal(detectClientLanguage(['Where can I see my plan?']).value, 'EN');
});

test('короткая кириллица без казахских букв не перетягивает казахский диалог', () => {
  assert.equal(detectClientLanguage(['Тарифімді қайдан көремін?', 'Таптым.']).value, 'KZ');
});

test('только короткие русские реплики всё равно дают русский', () => {
  assert.equal(detectClientLanguage(['Да', 'Спасибо']).value, 'RU');
});

test('заметная доля второго языка даёт mixed', () => {
  assert.equal(detectClientLanguage(['Где посмотреть мой тариф?', 'Покажите мне отчёт брокера', 'I need it in English please']).value, 'mixed');
});

test('цифры и код не влияют на определение языка', () => {
  assert.equal(detectClientLanguage(['Where is my report?', '123456']).value, 'EN');
});

test('без реплик клиента язык неизвестен', () => {
  assert.equal(detectClientLanguage([]).value, null);
});

test('факты: первая и последняя реплика оператора', () => {
  const { facts } = normalizeConversation(chat([
    ['00:00', 'client', 'a'], ['00:10', 'operator', 'b'], ['00:20', 'client', 'c'], ['00:30', 'operator', 'd'], ['00:40', 'client', 'e'],
  ]));
  assert.equal(facts.first_operator_msg, 'm1');
  assert.equal(facts.last_operator_msg, 'm3');
});

test('если оператора не было, факты о нём пусты', () => {
  const { facts } = normalizeConversation(chat([['00:00', 'client', 'a']]));
  assert.equal(facts.first_operator_msg, null);
  assert.equal(facts.last_operator_msg, null);
  assert.deepEqual(facts.operator_pauses, []);
});

test('первая реакция оператора в паузы не входит: по PDF этот порог не оценивается', () => {
  const { facts } = normalizeConversation(chat([['00:00', 'client', 'a'], ['10:00', 'operator', 'b']]));
  assert.deepEqual(facts.operator_pauses, []);
});

test('длинная пауза оператора отмечается с признаком предупреждения', () => {
  const { facts } = normalizeConversation(chat([
    ['00:00', 'client', 'a'], ['00:10', 'operator', 'Минуту, проверю'], ['04:00', 'operator', 'Готово'],
    ['04:10', 'client', 'b'], ['09:00', 'operator', 'Вот ответ'],
  ]), { pauseThresholdSec: 180 });
  assert.deepEqual(facts.operator_pauses.map((p) => [p.msg_id, p.warned]), [['m2', true], ['m4', false]]);
});

test('порог паузы берётся из настройки', () => {
  const turns = [['00:00', 'client', 'a'], ['00:10', 'operator', 'b'], ['00:20', 'client', 'c'], ['01:30', 'operator', 'd']];
  assert.equal(normalizeConversation(chat(turns), { pauseThresholdSec: 60 }).facts.operator_pauses.length, 1);
  assert.equal(normalizeConversation(chat(turns), { pauseThresholdSec: 180 }).facts.operator_pauses.length, 0);
});

test('самая длинная пауза оператора доступна даже ниже порога', () => {
  const { facts } = normalizeConversation(chat([
    ['00:00', 'client', 'a'], ['00:10', 'operator', 'b'], ['00:20', 'client', 'c'], ['01:30', 'operator', 'd'],
  ]));
  assert.deepEqual(facts.longest_operator_pause, { msg_id: 'm3', seconds: 70 });
});

test('системные события распознаются на всех языках набора', () => {
  const cases = [
    ['Оператор закрыл чат.', 'closed_by_operator'], ['Оператор чатты жапты.', 'closed_by_operator'], ['Agent closed the chat.', 'closed_by_operator'],
    ['Соединение с клиентом прервано.', 'connection_lost'], ['Клиентпен байланыс үзілді.', 'connection_lost'], ['Connection to customer lost.', 'connection_lost'],
    ['Клиент покинул чат.', 'client_left'], ['Клиент завершил разговор.', 'client_left'],
    ['Личность клиента подтверждена.', 'identity_verified'], ['Клиенттің жеке басы расталды.', 'identity_verified'], ['Customer identity verified.', 'identity_verified'],
    ['Клиент больше не находится на удержании.', 'hold_end'], ['Клиент находится на удержании.', 'hold_start'],
  ];
  for (const [text, kind] of cases) {
    const { facts } = normalizeConversation(chat([['00:00', 'system', text]]));
    assert.equal(facts.system_events[0].kind, kind, text);
  }
});

test('незнакомое событие остаётся как other и не ломает разбор', () => {
  const { facts } = normalizeConversation(chat([['00:00', 'system', 'Что-то новое']]));
  assert.equal(facts.system_events[0].kind, 'other');
});

test('у чатов нет позиции в записи', () => {
  assert.equal(normalizeConversation(chat([['00:00', 'client', 'a']])).messages[0].audio_sec, null);
});

test('позиция в записи считается от старта записи, а не от первого события', () => {
  const n = normalizeConversation(call([
    [0, 'bot', 'a'], [30, 'system', 'Запись и транскрибирование запущены.'], [40, 'operator', 'b'],
  ]));
  assert.equal(n.messages[2].audio_sec, 10);
});

test('реплика до старта записи ведёт в начало файла', () => {
  const n = normalizeConversation(call([
    [0, 'operator', 'a'], [30, 'system', 'Запись и транскрибирование запущены.'], [40, 'client', 'b'],
  ]));
  assert.equal(n.messages[0].audio_sec, 0);
});

test('пауза записи вырезается из позиции', () => {
  const n = normalizeConversation(call([
    [0, 'system', 'Запись и транскрибирование запущены.'], [50, 'system', 'Запись и транскрибирование приостановлены.'],
    [60, 'system', 'Запись и транскрибирование возобновлены.'], [70, 'client', 'a'],
  ]));
  assert.equal(n.messages[3].audio_sec, 60);
});

test('реплика внутри паузы ведёт к точке возобновления', () => {
  const n = normalizeConversation(call([
    [0, 'system', 'Запись и транскрибирование запущены.'], [50, 'system', 'Запись и транскрибирование приостановлены.'],
    [55, 'client', 'a'], [60, 'system', 'Запись и транскрибирование возобновлены.'],
  ]));
  assert.equal(n.messages[2].audio_sec, 50);
});

test('казахское событие старта записи тоже распознаётся', () => {
  const n = normalizeConversation(call([
    [0, 'bot', 'a'], [5, 'system', 'Жазу және транскрипция басталды.'], [15, 'client', 'b'],
  ]));
  assert.equal(n.messages[2].audio_sec, 10);
});

test('без событий записи отсчёт идёт от первого timestamp', () => {
  const n = normalizeConversation(call([[10, 'bot', 'a'], [25, 'client', 'b']]));
  assert.equal(n.messages[1].audio_sec, 15);
});

test('все записи sample разбираются, а реплики сохраняют текст', () => {
  const { data } = JSON.parse(fs.readFileSync(new URL('../data/dev.sample.json', import.meta.url), 'utf8'));
  for (const record of data.records) {
    const n = normalizeConversation(record);
    assert.equal(n.messages.length, record.transcript.length);
    assert.equal(n.messages.at(-1).text, record.transcript.at(-1).text);
    assert.ok(n.facts.first_operator_msg);
  }
});
