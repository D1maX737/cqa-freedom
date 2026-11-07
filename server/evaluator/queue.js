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
