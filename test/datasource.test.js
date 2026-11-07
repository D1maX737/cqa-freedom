import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDatasetUrl, parseDatasetResponse, fetchDataset, extractAudioSource,
  assertAllowedAudioUrl, resolveAudioUrl, normalizeImportBody,
} from '../server/datasource.js';

const BASE = `https://x.api.powerplatform.com/invoke?api-version=1&sp=%2Ftriggers&sig=${'SECRET'.repeat(5)}`;

test('group_id подставляется параметром, а исходные параметры не меняются', () => {
  assert.equal(buildDatasetUrl(BASE, 'DEV'), `${BASE}&group_id=DEV`);
});

test('group_id кодируется, чтобы нельзя было подмешать параметры', () => {
  assert.ok(buildDatasetUrl(BASE, 'A&sig=1').endsWith('&group_id=A%26sig%3D1'));
});

test('успешный ответ разбирается в группу и записи', () => {
  const r = parseDatasetResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [{ conversation_id: 'a' }] } });
  assert.equal(r.groupId, 'DEV');
  assert.equal(r.records.length, 1);
});

test('isSuccess=false превращается в ошибку с текстом API', () => {
  assert.throws(() => parseDatasetResponse({ error: 'bad group', isSuccess: false, data: null }), /bad group/);
});

test('сетевая ошибка не раскрывает подпись из URL', async () => {
  const fetchImpl = async (url) => { throw new Error(`connect failed ${url}`); };
  await assert.rejects(fetchDataset('DEV', { baseUrl: BASE, fetchImpl }), (e) => {
    assert.ok(!e.message.includes('SECRET'), e.message);
    return true;
  });
});

test('HTTP-ошибка не раскрывает подпись из URL', async () => {
  const fetchImpl = async () => new Response('nope', { status: 403 });
  await assert.rejects(fetchDataset('DEV', { baseUrl: BASE, fetchImpl }), (e) => {
    assert.match(e.message, /403/);
    assert.ok(!e.message.includes('SECRET'));
    return true;
  });
});

test('без DATASET_URL fetchDataset даёт понятную ошибку', async () => {
  await assert.rejects(fetchDataset('DEV', { baseUrl: '' }), /DATASET_URL/);
});

test('mp3-ссылка извлекается из HTML-обёртки и &amp; раскодируется', () => {
  const html = '<audio><source src="https://a.dynamics.com/f?sp=r&amp;sig=1&rsct=audio%2Fmpeg" type="audio/mpeg"></audio>';
  assert.equal(extractAudioSource(html), 'https://a.dynamics.com/f?sp=r&sig=1&rsct=audio%2Fmpeg');
});

test('HTML без source даёт null', () => {
  assert.equal(extractAudioSource('<html></html>'), null);
});

test('ссылка на запись с чужого хоста отклоняется', () => {
  assert.throws(() => assertAllowedAudioUrl('https://169.254.169.254/latest', '.powerplatform.com'), /хост/);
  assert.throws(() => assertAllowedAudioUrl('http://x.api.powerplatform.com/a', '.powerplatform.com'), /https/);
  assert.doesNotThrow(() => assertAllowedAudioUrl('https://x.api.powerplatform.com/a', '.powerplatform.com'));
});

test('resolveAudioUrl получает свежую ссылку из страницы-обёртки', async () => {
  const fetchImpl = async () => new Response('<source src="https://a.dynamics.com/fresh.mp3">', { headers: { 'content-type': 'text/html' } });
  const url = await resolveAudioUrl('https://x.api.powerplatform.com/rec', { fetchImpl, hostSuffix: '.powerplatform.com' });
  assert.equal(url, 'https://a.dynamics.com/fresh.mp3');
});

test('resolveAudioUrl не парсит ответ, если это уже аудио', async () => {
  const fetchImpl = async () => new Response('ID3', { headers: { 'content-type': 'audio/mpeg' } });
  const url = await resolveAudioUrl('https://x.api.powerplatform.com/rec', { fetchImpl, hostSuffix: '.powerplatform.com' });
  assert.equal(url, 'https://x.api.powerplatform.com/rec');
});

const rec = { conversation_id: 'c1', channel: 'agent chat', language: 'RU', transcript: [{ timestamp: '00:01', speaker: 'client', text: 'Привет' }], audio_url: null };

test('импорт принимает ответ API целиком, массив и одну запись', () => {
  assert.equal(normalizeImportBody({ isSuccess: true, data: { records: [rec] } }).length, 1);
  assert.equal(normalizeImportBody([rec, { ...rec, conversation_id: 'c2' }]).length, 2);
  assert.equal(normalizeImportBody(rec).length, 1);
});

test('импорт отклоняет запись без транскрипта', () => {
  assert.throws(() => normalizeImportBody({ ...rec, transcript: 'нет' }), /transcript/);
});

test('импорт отклоняет неизвестную роль', () => {
  const bad = { ...rec, transcript: [{ timestamp: '00:01', speaker: 'alien', text: 'x' }] };
  assert.throws(() => normalizeImportBody(bad), /speaker/);
});
