// Ручная разметка эталона для замера точности.
// Каждый размечающий пишет свой файл eval/labels/<имя>.json: разметку нескольких людей
// с разных компьютеров можно свести обычным git pull, без конфликтов в одном файле.
// В файлах только идентификаторы диалогов и ответы людей, текста диалогов там нет.
import fs from 'node:fs';
import path from 'node:path';
import { allowedAnswers } from './checklist.js';

const NOTE_LIMIT = 500;

export function labelerSlug(name) {
  const slug = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(slug)) throw new Error('Укажите имя размечающего: буквы, цифры или дефис, до 40 символов');
  return slug;
}

/** Грубая ошибка размечается как «есть» или «нет», остальные критерии — значениями из чек-листа. */
export const labelValues = (criterion) => (criterion.type === 'flag' ? ['yes', 'no'] : allowedAnswers(criterion));

export function validateLabel(entry, checklist) {
  const errors = [];
  for (const criterion of checklist.criteria) {
    const value = entry?.criteria?.[criterion.id]?.value;
    const allowed = labelValues(criterion);
    if (value === undefined || value === null || value === '') errors.push(`${criterion.id}: не выбран ответ`);
    else if (!allowed.includes(String(value))) errors.push(`${criterion.id}: недопустимое значение «${value}», можно: ${allowed.join(', ')}`);
  }
  return errors;
}

function readFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Файл разметки ${path.basename(file)} повреждён: ${error.message}`);
  }
}

/** Все разметки из каталога плоским списком: одна запись на пару «размечающий × диалог». */
export function readLabels(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().flatMap((name) => {
    const data = readFile(path.join(dir, name));
    const labeler = data.labeler ?? path.basename(name, '.json');
    return Object.entries(data.labels ?? {}).map(([conversationId, entry]) => ({ conversation_id: conversationId, labeler, ...entry }));
  });
}

function cleanCriteria(criteria) {
  return Object.fromEntries(Object.entries(criteria).map(([id, item]) => {
    const clean = { value: String(item.value) };
    if (item.disputed === true) clean.disputed = true;
    const note = typeof item.note === 'string' ? item.note.trim().slice(0, NOTE_LIMIT) : '';
    if (note) clean.note = note;
    return [id, clean];
  }));
}

/** Сохраняет разметку диалога в файл размечающего; повторная разметка того же диалога перезаписывает прежнюю. */
export function saveLabel(dir, labeler, conversationId, { checklist_version_id: versionId, criteria }) {
  const slug = labelerSlug(labeler);
  const file = path.join(dir, `${slug}.json`);
  const data = fs.existsSync(file) ? readFile(file) : { labeler: slug, labels: {} };
  const entry = { checklist_version_id: versionId, labeled_at: new Date().toISOString(), criteria: cleanCriteria(criteria) };
  data.labels = { ...data.labels, [conversationId]: entry };
  // Ключи по порядку — стабильный diff в git.
  data.labels = Object.fromEntries(Object.entries(data.labels).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ labeler: slug, labels: data.labels }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { conversation_id: conversationId, labeler: slug, ...entry };
}
