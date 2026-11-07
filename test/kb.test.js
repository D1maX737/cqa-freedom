import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseKbFile, loadKb } from '../server/kb.js';

test('frontmatter разбирается в теги, источник и дату', () => {
  const doc = parseKbFile('a.md', '---\ntags: [tariff, report]\nsource: Регламент\neffective_date: 2026-01-01\n---\nТекст правила.\n');
  assert.deepEqual(doc.tags, ['tariff', 'report']);
  assert.equal(doc.source, 'Регламент');
  assert.equal(doc.effective_date, '2026-01-01');
  assert.equal(doc.body, 'Текст правила.');
});

test('файл без обязательного source отклоняется: правило без источника использовать нельзя', () => {
  assert.throws(() => parseKbFile('a.md', 'Просто текст'), /source/);
});

test('загружаются только .md, остальные файлы папки игнорируются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '---\nsource: S\n---\nТекст');
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  assert.equal(loadKb(dir).length, 1);
  fs.rmSync(dir, { recursive: true });
});
