const SPEAKERS = new Set(['client', 'operator', 'bot', 'system']);

/** Подпись в DATASET_URL секретна: её нельзя выводить в лог и текст ошибки. */
export function buildDatasetUrl(baseUrl, groupId) {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}group_id=${encodeURIComponent(groupId)}`;
}

export function parseDatasetResponse(body) {
  if (!body?.isSuccess) throw new Error(`API организаторов вернул ошибку: ${body?.error || 'нет описания'}`);
  const records = body.data?.records;
  if (!Array.isArray(records)) throw new Error('В ответе API нет массива data.records');
  return { groupId: body.data.dataset_group_id, total: body.data.total_records, records };
}

export async function fetchDataset(groupId, { baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Не задан DATASET_URL: добавьте его в .env');
  let response;
  try {
    response = await fetchImpl(buildDatasetUrl(baseUrl, groupId));
  } catch (error) {
    throw new Error(`Не удалось связаться с API организаторов (${error.cause?.code ?? error.name})`);
  }
  if (!response.ok) throw new Error(`API организаторов ответил HTTP ${response.status}`);
  const parsed = parseDatasetResponse(await response.json());
  parsed.records.forEach(assertRecord);
  return parsed;
}

function assertRecord(record, index = 0) {
  const label = record?.conversation_id ?? `запись ${index}`;
  if (typeof record?.conversation_id !== 'string' || !record.conversation_id) throw new Error(`${label}: нет conversation_id`);
  if (typeof record.channel !== 'string') throw new Error(`${label}: нет channel`);
  if (typeof record.language !== 'string') throw new Error(`${label}: нет language`);
  if (!Array.isArray(record.transcript)) throw new Error(`${label}: transcript должен быть массивом`);
  for (const turn of record.transcript) {
    if (!SPEAKERS.has(turn?.speaker)) throw new Error(`${label}: неизвестный speaker «${turn?.speaker}»`);
    if (typeof turn.text !== 'string' || typeof turn.timestamp !== 'string') {
      throw new Error(`${label}: у реплики нужны timestamp и text`);
    }
  }
}

/** Принимает ответ API целиком, массив записей или одну запись. */
export function normalizeImportBody(body) {
  let records;
  if (Array.isArray(body)) records = body;
  else if (Array.isArray(body?.data?.records)) records = body.data.records;
  else if (Array.isArray(body?.records)) records = body.records;
  else records = [body];
  if (records.length === 0) throw new Error('В файле нет диалогов');
  records.forEach(assertRecord);
  return records;
}

export function extractAudioSource(html) {
  const match = /<source[^>]*\ssrc="([^"]+)"/i.exec(html);
  return match ? match[1].replaceAll('&amp;', '&') : null;
}

export function assertAllowedAudioUrl(url, hostSuffix) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Ссылка на запись должна быть https');
  if (!parsed.hostname.endsWith(hostSuffix)) throw new Error('Недопустимый хост ссылки на запись');
}

/**
 * audio_url организаторов ведёт на HTML-страницу с плеером, а mp3-ссылка внутри живёт около часа.
 * Поэтому настоящий адрес получаем в момент прослушивания.
 */
export async function resolveAudioUrl(audioUrl, { fetchImpl = fetch, hostSuffix }) {
  assertAllowedAudioUrl(audioUrl, hostSuffix);
  const response = await fetchImpl(audioUrl);
  if (!response.ok) throw new Error(`Страница записи ответила HTTP ${response.status}`);
  if ((response.headers.get('content-type') ?? '').startsWith('audio/')) return audioUrl;
  const source = extractAudioSource(await response.text());
  if (!source || !source.startsWith('https://')) throw new Error('На странице записи нет ссылки на аудио');
  return source;
}
