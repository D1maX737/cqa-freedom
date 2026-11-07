import test from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets } from '../scripts/check-secrets.js';

test('подпись URL считается секретом', () => {
  assert.equal(findSecrets('a.md', `url?sig=${'A'.repeat(32)}`).length, 1);
});

test('ключ Anthropic считается секретом', () => {
  assert.equal(findSecrets('a.js', `const k = "sk-ant-${'a'.repeat(20)}"`).length, 1);
});

test('упоминание параметра sig без значения разрешено', () => {
  assert.equal(findSecrets('README.md', 'Ссылка содержит подпись `sig=...`').length, 0);
});

test('рабочие данные нельзя коммитить, даже без подписи внутри', () => {
  for (const p of ['data/dev.json', 'data/cqa.db', 'docs/task.pdf', '.env']) {
    assert.equal(findSecrets(p, 'ok').length, 1, p);
  }
});

test('синтетический sample и .env.example разрешены', () => {
  assert.equal(findSecrets('data/dev.sample.json', '{}').length, 0);
  assert.equal(findSecrets('.env.example', 'DATASET_URL=').length, 0);
});
