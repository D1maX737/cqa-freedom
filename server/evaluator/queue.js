export async function runPool(items, concurrency, worker, onError = () => {}) {
  const queue = [...items];
  const runner = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (error) {
        onError(error, item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

/** Очередь оценок сервера: ограничивает параллельные вызовы LLM и умеет дождаться опустошения. */
export function createEvaluationQueue({ concurrency, run }) {
  const pending = [];
  const waiters = [];
  let active = 0;

  const settle = () => {
    if (active === 0 && pending.length === 0) waiters.splice(0).forEach((resolve) => resolve());
  };
  const pump = () => {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift();
      active += 1;
      Promise.resolve().then(() => run(job)).catch(() => {}).finally(() => {
        active -= 1;
        pump();
        settle();
      });
    }
  };

  return {
    enqueue(jobs) {
      pending.push(...jobs);
      pump();
    },
    idle: () => (active === 0 && pending.length === 0 ? Promise.resolve() : new Promise((resolve) => { waiters.push(resolve); })),
    size: () => active + pending.length,
  };
}
