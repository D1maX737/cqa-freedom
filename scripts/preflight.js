#!/usr/bin/env node
// Проверка перед контрольным часом и защитой: npm run preflight
// Значения секретов не печатает — только задан ли параметр.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, ROOT } from '../server/config.js';
import { openDb } from '../server/db.js';
import { exportProblems } from '../server/export.js';
import { configuredModel } from '../server/llm/index.js';

const lines = [];
const ok = (text) => lines.push(['✓', text]);
const warn = (text) => lines.push(['!', text]);
const fail = (text) => lines.push(['✗', text]);
const gitRaw = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const git = (...args) => gitRaw(...args)?.trim() ?? null;

// Окружение
if (!fs.existsSync(path.join(ROOT, '.env'))) fail('Нет файла .env: cp .env.example .env и заполните');
if (config.llmProvider === 'mock') fail('LLM_PROVIDER=mock: это заглушка, её оценки в results.json не выгружаются');
else if (config.llmProvider === 'gemini' && !config.geminiApiKey) fail('LLM_PROVIDER=gemini, но GEMINI_API_KEY пуст');
else if (config.llmProvider === 'anthropic' && !config.anthropicApiKey) fail('LLM_PROVIDER=anthropic, но ANTHROPIC_API_KEY пуст');
else ok(`Модель: ${config.llmProvider}, ${configuredModel(config)}${config.llmProvider === 'gemini' ? `, рассуждения ${config.geminiThinking || 'по умолчанию'}, ${config.geminiRpm} запросов в минуту` : ''}`);
if (config.datasetUrl) ok('DATASET_URL задан: набор можно загрузить из API организаторов');
else fail('DATASET_URL пуст: контрольный набор не загрузить');
const team = process.env.TEAM_NAME?.trim();
if (team) ok(`Команда для results.json: ${team}`);
else warn('TEAM_NAME пуст: в npm run export придётся передать --team "Название"');
if (config.recheck) warn('RECHECK=1: на рискованных диалогах уйдёт второй запрос, лимит тратится быстрее');

// База
const db = openDb(config.dbPath);
const versions = db.checklists.list();
const v1 = versions[0];
if (!v1) warn('В базе нет чек-листа: v1 создастся при первом запуске сервера или выгрузки');
else {
  const problems = exportProblems(v1.config);
  if (problems.length) fail(`Чек-лист ${v1.id} нельзя выгрузить: ${problems.join('; ')}`);
  else ok(`Чек-лист ${v1.id} «${v1.name}»: у всех критериев есть коды выгрузки`);
}
const decided = db.appeals.list('decided').filter((a) => a.action === 'change');
if (decided.length && config.usePrecedents) {
  warn(`Решений по апелляциям в базе: ${decided.length}. При оценке они попадут в промпт как прецеденты. `
    + 'Если это тестовые решения с репетиции, оценивайте контрольный набор с PRECEDENTS=0');
} else ok(config.usePrecedents ? 'Решений по апелляциям нет: промпт без прецедентов' : 'Прецеденты выключены (PRECEDENTS=0)');
const open = db.appeals.list('open').length;
if (open) warn(`Открытых апелляций: ${open}`);
const groups = db.conversations.groups();
ok(`Диалоги в базе: ${groups.map((g) => `${g.group_id} ${g.total}`).join(', ') || 'нет'}`);
db.close();

// Результаты и git
for (const set of ['dev', 'prod']) {
  const file = path.join(ROOT, 'results', set, 'results.json');
  if (!fs.existsSync(file)) {
    (set === 'dev' ? warn : ok)(`results/${set}/results.json ещё нет${set === 'dev' ? ': npm run export -- DEV dev --checklist v1' : ' (появится в контрольный час)'}`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tracked = git('ls-files', '--error-unmatch', `results/${set}/results.json`) !== null;
  const errors = data.results.filter((r) => r.status === 'error').length;
  (tracked ? ok : warn)(`results/${set}/results.json: ${data.results.length} записей, с ошибкой ${errors}, команда «${data.team_name}»${tracked ? '' : ' — НЕ в git: git add и push'}`);
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch === null) warn('Это не git-репозиторий: результаты сдаются через git push');
else {
  ok(`Ветка ${branch}${git('remote', 'get-url', 'origin') ? ', origin настроен' : ''}`);
  // Без trim: первая строка porcelain начинается с пробела, а имя файла — с четвёртого символа.
  const dirty = gitRaw('status', '--porcelain')?.split('\n').filter(Boolean) ?? [];
  if (dirty.length) warn(`Незакоммиченных изменений: ${dirty.length} (${dirty.slice(0, 4).map((l) => l.slice(3)).join(', ')}${dirty.length > 4 ? ', …' : ''})`);
  if (git('ls-files', '--error-unmatch', '.env') !== null) fail('.env в git! Уберите: git rm --cached .env');
}

for (const [mark, text] of lines) console.log(`${mark} ${text}`);
const failed = lines.filter(([mark]) => mark === '✗').length;
console.log(failed ? `\nНужно исправить: ${failed}.` : '\nКритичных проблем нет.');
process.exit(failed ? 1 : 0);
