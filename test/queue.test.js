import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from '../server/evaluator/queue.js';

test('пул не превышает заданный параллелизм и обрабатывает всё', async () => {
  let active = 0;
  let peak = 0;
  const done = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    active -= 1;
    done.push(item);
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test('ошибка одного элемента не останавливает остальные', async () => {
  const done = [];
  const errors = [];
  await runPool([1, 2, 3], 1, async (item) => {
    if (item === 2) throw new Error('сбой');
    done.push(item);
  }, (error) => errors.push(error.message));
  assert.deepEqual(done, [1, 3]);
  assert.deepEqual(errors, ['сбой']);
});
