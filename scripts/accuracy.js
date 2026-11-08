#!/usr/bin/env node
// Точность модели против ручной разметки из eval/labels в виде таблиц markdown для README:
//   npm run accuracy                     → набор DEV, чек-лист организаторов (первая версия)
//   npm run accuracy -- DEV --checklist v1
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { collectAccuracy } from '../server/accuracy.js';
import { readLabels } from '../server/labels.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const versionArg = flag('--checklist');
const allowMock = args.includes('--allow-mock');
const groupId = args.find((a) => !a.startsWith('--')) ?? 'DEV';

const pct = (rate) => (rate === null ? '—' : `${(rate * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`);
const num = (n) => (n === null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }));
const row = (cells) => `| ${cells.join(' | ')} |`;

const db = openDb(config.dbPath);
let report;
try {
  report = collectAccuracy(db, {
    versionId: versionArg ?? db.checklists.list()[0]?.id,
    groupId,
    labels: readLabels(config.labelsDir),
    tuningIds: config.tuningIds,
    allowMock,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { coverage, overall, clear, by_split: split, gross, total_deviation: deviation } = report;
console.log(`Набор ${groupId}, чек-лист ${report.checklist_version_id}, модель: ${report.models.join(', ') || '—'}`);
console.log(`Сравнено диалогов: ${coverage.compared} из ${coverage.conversations} (размечено ${coverage.labeled}, оценено моделью ${coverage.evaluated})`);
if (report.mock_skipped) console.log(`Оценки заглушкой не учтены: ${report.mock_skipped}`);
if (!coverage.compared) process.exit(0);

console.log(`\n${row(['', 'Ответов', 'Совпадение'])}\n${row(['---', '---:', '---:'])}`);
console.log(row(['Все размеченные ответы', overall.cells, `**${pct(overall.rate)}**`]));
console.log(row(['Без спорных', clear.cells, pct(clear.rate)]));
console.log(row(['Диалоги, не использованные при настройке промпта', split.holdout.cells, pct(split.holdout.rate)]));
if (split.tuning.cells) console.log(row(['Диалоги, на которых настраивали промпт', split.tuning.cells, pct(split.tuning.rate)]));

console.log(`\nГрубые ошибки: найдено ${gross.found} из ${gross.human}, ложных срабатываний ${gross.false_alarms}.`
  + ` Отклонение итога: ±${num(deviation.mean)} в среднем, максимум ${num(deviation.max)}. κ Коэна ${num(report.kappa)}.`);

console.log(`\n${row(['Критерий', 'Ответов', 'Совпадение'])}\n${row(['---', '---:', '---:'])}`);
for (const c of report.by_criterion) console.log(row([`${c.id} ${c.title}`, c.cells, pct(c.rate)]));

console.log(`\n${row(['Язык', 'Ответов', 'Совпадение'])}\n${row(['---', '---:', '---:'])}`);
for (const l of report.by_language) console.log(row([l.language, l.cells, pct(l.rate)]));

if (report.agreement.conversations) {
  console.log(`\nРазмечавшие между собой: совпало ${report.agreement.matched} из ${report.agreement.cells} ответов в ${report.agreement.conversations} диалогах.`);
}
console.log(`\nРасхождений с разметкой: ${report.mismatches.length}. Список — на странице «Точность».`);
