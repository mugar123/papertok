export async function settleWithin(promise, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason }),
      ),
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve({ status: 'timed_out' }), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function resolveWithin(promise, timeoutMs, fallbackValue) {
  const result = await settleWithin(promise, timeoutMs);
  return result.status === 'fulfilled' ? result.value : fallbackValue;
}
