import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, parsePastedDialog } from '../server/paste.js';

test('вставленный диалог: время, роли на трёх языках и перенос строки внутри реплики', () => {
  const record = parsePastedDialog(`00:00 клиент: Не могу вывести деньги
[00:15] Оператор: Здравствуйте, меня зовут Алия.
Подскажите, какое сообщение вы видите?
01:02 client: Error 403
1:10 бот: Оператор подключился
01:20 system: Эскалация`, { conversationId: 'own-1' });
  assert.equal(record.conversation_id, 'own-1');
  assert.equal(record.channel, 'agent chat');
  assert.deepEqual(record.transcript.map((t) => [t.timestamp, t.speaker]), [
    ['00:00', 'client'], ['00:15', 'operator'], ['01:02', 'client'], ['01:10', 'bot'], ['01:20', 'system'],
  ]);
  assert.equal(record.transcript[1].text, 'Здравствуйте, меня зовут Алия.\nПодскажите, какое сообщение вы видите?');
  assert.equal(record.audio_url, null);
});

test('вставленный диалог: без времени метки идут по порядку через 10 секунд', () => {
  const record = parsePastedDialog('Клиент: Сәлеметсіз бе\nОператор: Сәлеметсіз бе, мен Айгүлмін.\nКлиент: Рақмет', { conversationId: 'x' });
  assert.deepEqual(record.transcript.map((t) => t.timestamp), ['00:00', '00:10', '00:20']);
  assert.equal(record.language, 'KZ');
});

test('язык определяется по тексту клиента, если не указан', () => {
  assert.equal(detectLanguage('Сәлеметсіз бе, шотты қалай ашамын?'), 'KZ');
  assert.equal(detectLanguage('Здравствуйте, как открыть счёт?'), 'RU');
  assert.equal(detectLanguage('Hello, how do I open an account?'), 'EN');
  assert.equal(parsePastedDialog('client: Hello\noperator: Hi, I am Tom', { conversationId: 'x', language: 'RU' }).language, 'RU');
});

test('вставленный диалог: понятные ошибки без ролей, с неизвестной ролью и без оператора', () => {
  assert.throws(() => parsePastedDialog('просто текст без ролей', { conversationId: 'x' }), /оператор: текст/);
  assert.throws(() => parsePastedDialog('00:00 менеджер: привет\n00:05 оператор: здравствуйте', { conversationId: 'x' }), /менеджер/);
  assert.throws(() => parsePastedDialog('клиент: привет\nбот: здравствуйте', { conversationId: 'x' }), /нет ни одной реплики оператора/);
});
