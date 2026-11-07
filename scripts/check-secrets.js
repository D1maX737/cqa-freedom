#!/usr/bin/env node
// Запускается из pre-commit: репозиторий публичный, а в data/ и docs/ лежат секреты и реальные звонки.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTENT_RULES = [
  { name: 'подпись URL (sig=)', pattern: /\bsig=[A-Za-z0-9_%-]{20,}/ },
  { name: 'ключ Anthropic', pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },
];

const FORBIDDEN_PATHS = [
  /^\.env$/,
  /^docs\/.*\.pdf$/,
  /^data\/(?!dev\.sample\.json$).+/,
  /\.db$/,
];

export function findSecrets(filePath, content) {
  const problems = [];
  if (FORBIDDEN_PATHS.some((rule) => rule.test(filePath))) problems.push(`${filePath}: файл нельзя коммитить`);
  for (const { name, pattern } of CONTENT_RULES) {
    if (pattern.test(content)) problems.push(`${filePath}: найдено — ${name}`);
  }
  return problems;
}

function main() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').filter(Boolean);
  const problems = staged.flatMap((file) => findSecrets(file, git('show', `:${file}`)));
  if (problems.length) {
    console.error(`Коммит остановлен:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
