import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
  }
  return value;
}

export function parseKbFile(file, content) {
  const match = FRONTMATTER.exec(content);
  const meta = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) meta[line.slice(0, colon).trim()] = parseValue(line.slice(colon + 1));
  }
  if (!meta.source) throw new Error(`${file}: в frontmatter нет source`);
  return {
    file,
    tags: meta.tags ?? [],
    source: meta.source,
    effective_date: meta.effective_date ?? null,
    body: (match?.[2] ?? '').trim(),
  };
}

export function loadKb(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
    .map((name) => parseKbFile(name, fs.readFileSync(path.join(dir, name), 'utf8')));
}
