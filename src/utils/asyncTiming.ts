export type SettledWithin<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | { status: 'timed_out'; reason?: never };

export async function settleWithin<T>(promise: T | PromiseLike<T>, timeoutMs: number): Promise<SettledWithin<Awaited<T>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      ),
      new Promise<{ status: 'timed_out' }>(resolve => {
        timeoutId = setTimeout(() => resolve({ status: 'timed_out' }), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function resolveWithin<T, F>(promise: T | PromiseLike<T>, timeoutMs: number, fallbackValue: F) {
  const result = await settleWithin(promise, timeoutMs);
  return result.status === 'fulfilled' ? result.value : fallbackValue;
}
