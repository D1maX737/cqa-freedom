const KAZAKH_LETTERS = /[әғқңөұүһі]/iu;
const CYRILLIC = /[а-яё]/iu;
const LATIN = /[a-z]/i;
const SHORT_CYRILLIC = 12;
const WAIT_WORDS = /минут|секунд|момент|подожд|ожида|күт|сәл|wait|moment|minute|second|hold/iu;

// Порядок важен: более узкие формулировки стоят раньше.
const SYSTEM_EVENT_RULES = [
  ['hold_end', /больше не находится на удержании/iu],
  ['hold_start', /находится на удержании/iu],
  ['recording_paused', /приостановлен|recording.*paused/iu],
  ['recording_resumed', /возобновлен|recording.*resumed/iu],
  ['recording_started', /запись.*запущен|жазу.*басталды|recording.*started/iu],
  ['closed_by_operator', /оператор закрыл чат|оператор чатты жапты|agent closed the chat/iu],
  ['connection_lost', /соединение с клиентом прервано|байланыс үзілді|connection to customer lost/iu],
  ['client_left', /клиент покинул чат|клиент завершил разговор/iu],
  ['identity_verified', /личность клиента подтверждена|жеке басы расталды|identity verified/iu],
  ['operator_joined', /эскалация на оператора|чат операторға жіберілді|chat transferred to an agent|агент присоединился/iu],
  ['transfer', /клиент переведен/iu],
  ['operator_left', /агент вышел/iu],
  ['consultation', /консультаци[яю] с агентом/iu],
  ['language_changed', /languages have been updated/iu],
];

const CLOSING_KINDS = new Set(['closed_by_operator', 'connection_lost', 'client_left']);

export function parseChatTime(value) {
  const [minutes, seconds] = value.split(':').map(Number);
  return minutes * 60 + seconds;
}

/** Date.parse обязан понимать только три знака долей секунды, а у звонков их семь. */
const parseIsoSeconds = (value) => Date.parse(value.replace(/(\.\d{3})\d+/, '$1')) / 1000;

const isClockTime = (value) => /^\d+:\d{2}$/.test(value);
const rawSeconds = (value) => (isClockTime(value) ? parseChatTime(value) : parseIsoSeconds(value));

const round = (value) => Math.round(value * 100) / 100;

export function detectClientLanguage(texts) {
  const counts = { RU: 0, KZ: 0, EN: 0 };
  let shortCyrillic = 0;
  for (const text of texts) {
    if (KAZAKH_LETTERS.test(text)) counts.KZ += 1;
    else if (CYRILLIC.test(text)) {
      // «Таптым.» не содержит казахских букв: короткая реплика ничего не говорит о языке.
      if (text.trim().length < SHORT_CYRILLIC) shortCyrillic += 1;
      else counts.RU += 1;
    } else if (LATIN.test(text)) counts.EN += 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return { value: shortCyrillic > 0 ? 'RU' : null, counts };
  const [[top], [, second]] = ranked;
  return { value: second / total >= 1 / 3 ? 'mixed' : top, counts };
}

function classifySystemEvent(text) {
  return SYSTEM_EVENT_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

/** Запись стартует позже первого события, а на время пауз не пишется: длина файлов DEV это подтверждает. */
function buildAudioPosition(messages) {
  const events = messages.filter((m) => m.speaker === 'system').map((m) => ({ t: m.t_sec, kind: classifySystemEvent(m.text) }));
  const start = events.find((e) => e.kind === 'recording_started')?.t ?? 0;
  const pauses = [];
  for (const event of events) {
    if (event.kind === 'recording_paused') pauses.push({ from: event.t, to: Infinity });
    if (event.kind === 'recording_resumed' && pauses.at(-1)?.to === Infinity) pauses.at(-1).to = event.t;
  }
  return (t) => {
    const cut = pauses.reduce((sum, { from, to }) => sum + Math.max(0, Math.min(t, to) - Math.max(from, start)), 0);
    return round(Math.max(0, t - start - cut));
  };
}

function operatorPauses(messages, thresholdSec) {
  const pauses = [];
  let firstSeen = false;
  let lastOperatorText = '';
  messages.forEach((message, index) => {
    if (message.speaker !== 'operator') return;
    // Первая реакция сюда не входит: по стр. 2 чек-листа её порог не оценивается.
    if (firstSeen) {
      pauses.push({
        msg_id: message.id,
        seconds: message.t_sec - messages[index - 1].t_sec,
        warned: WAIT_WORDS.test(lastOperatorText),
      });
    }
    firstSeen = true;
    lastOperatorText = message.text;
  });
  const longest = pauses.reduce((best, p) => (best === null || p.seconds > best.seconds ? p : best), null);
  return {
    operator_pauses: pauses.filter((p) => p.seconds > thresholdSec),
    longest_operator_pause: longest && { msg_id: longest.msg_id, seconds: longest.seconds },
  };
}

export function normalizeConversation(record, { pauseThresholdSec = 180 } = {}) {
  const isVoice = record.channel === 'voice call';
  const first = record.transcript.length ? rawSeconds(record.transcript[0].timestamp) : 0;
  const messages = record.transcript.map((turn, index) => ({
    id: `m${index}`,
    timestamp: turn.timestamp,
    speaker: turn.speaker,
    text: turn.text,
    t_sec: round(rawSeconds(turn.timestamp) - first),
    audio_sec: null,
  }));

  if (isVoice) {
    const position = buildAudioPosition(messages);
    for (const message of messages) message.audio_sec = position(message.t_sec);
  }

  const operatorMessages = messages.filter((m) => m.speaker === 'operator');
  const systemEvents = messages.filter((m) => m.speaker === 'system')
    .map((m) => ({ msg_id: m.id, kind: classifySystemEvent(m.text), text: m.text }));

  return {
    conversation_id: record.conversation_id,
    channel: record.channel,
    language: record.language,
    audio_url: record.audio_url ?? null,
    messages,
    facts: {
      channel: record.channel,
      language_label: record.language,
      client_language: detectClientLanguage(messages.filter((m) => m.speaker === 'client').map((m) => m.text)),
      first_operator_msg: operatorMessages[0]?.id ?? null,
      last_operator_msg: operatorMessages.at(-1)?.id ?? null,
      ...(isVoice
        ? { operator_pauses: [], longest_operator_pause: null }
        : operatorPauses(messages, pauseThresholdSec)),
      system_events: systemEvents,
      closing_events: systemEvents.filter((e) => CLOSING_KINDS.has(e.kind)),
    },
  };
}
