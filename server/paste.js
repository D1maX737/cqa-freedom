// Свой диалог текстом: «00:12 оператор: текст» по строке на реплику. Нужен, чтобы проверить систему
// на собственном примере прямо на защите, без файла в формате API.
const ROLES = new Map([
  ['клиент', 'client'], ['клиентка', 'client'], ['client', 'client'], ['customer', 'client'],
  ['оператор', 'operator'], ['operator', 'operator'], ['agent', 'operator'], ['агент', 'operator'],
  ['бот', 'bot'], ['bot', 'bot'],
  ['система', 'system'], ['system', 'system'], ['жүйе', 'system'],
]);
const TIME = /^\[?(\d{1,2}):(\d{2})\]?\s+/;
const ROLE = /^([^\s:][^:]{0,30}?)\s*:\s*(.*)$/;
const STEP_SEC = 10;
const FORMAT = 'Формат строки: «00:12 оператор: текст», время можно не указывать; роли — клиент, оператор, бот, система';

const pad = (n) => String(n).padStart(2, '0');
const clockOf = (sec) => `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;

/** Казахские буквы — KZ, иначе кириллица — RU, иначе EN. */
export function detectLanguage(text) {
  if (/[әғқңөұүһі]/i.test(text)) return 'KZ';
  if (/[а-яё]/i.test(text)) return 'RU';
  return 'EN';
}

export function parsePastedDialog(text, { conversationId, language } = {}) {
  const messages = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const time = TIME.exec(line);
    const rest = time ? line.slice(time[0].length) : line;
    const parts = ROLE.exec(rest);
    const role = parts ? ROLES.get(parts[1].trim().toLowerCase()) : undefined;
    if (time && !role) {
      throw new Error(`Строка ${index + 1}: неизвестная роль «${parts?.[1]?.trim() ?? rest.slice(0, 20)}». ${FORMAT}`);
    }
    if (role) {
      messages.push({ sec: time ? Number(time[1]) * 60 + Number(time[2]) : null, speaker: role, text: parts[2].trim() });
    } else if (messages.length) {
      // Строка без роли продолжает предыдущую реплику.
      const last = messages.at(-1);
      last.text = last.text ? `${last.text}\n${line}` : line;
    }
  });
  if (!messages.length) throw new Error(`Не нашёл ни одной реплики. ${FORMAT}`);
  if (!messages.some((m) => m.speaker === 'operator')) throw new Error('В диалоге нет ни одной реплики оператора: оценивать нечего');

  let previous = -STEP_SEC;
  const transcript = messages.map((m) => {
    const sec = m.sec ?? previous + STEP_SEC;
    previous = sec;
    return { timestamp: clockOf(sec), speaker: m.speaker, text: m.text };
  });
  const clientText = messages.filter((m) => m.speaker === 'client').map((m) => m.text).join(' ');
  return {
    conversation_id: conversationId,
    channel: 'agent chat',
    language: language || detectLanguage(clientText || messages.map((m) => m.text).join(' ')),
    audio_url: null,
    transcript,
  };
}
