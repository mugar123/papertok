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

export function fulfilledPaperLists(results) {
  return (Array.isArray(results) ? results : []).flatMap((result) => (
    result?.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
  ));
}

/**
 * Same per-source budget as settleWithin, but the caller can paint as soon as
 * `isReady` is true instead of waiting for the slowest source. `all` still
 * settles every source so late papers can append without replacing the first
 * cards.
 */
export function settleSourcesForFirstPaint(promises, timeoutMs, isReady) {
  const tracked = [...promises].map((promise) => settleWithin(promise, timeoutMs));
  const results = Array.from({ length: tracked.length }, () => ({ status: 'pending' }));
  let resolved = false;

  const first = new Promise((resolve) => {
    const maybeFinish = () => {
      if (resolved) return;
      const papers = fulfilledPaperLists(results);
      const done = results.every((result) => result.status !== 'pending');
      if (done || (typeof isReady === 'function' && isReady(papers))) {
        resolved = true;
        resolve([...results]);
      }
    };
    if (tracked.length === 0) {
      resolved = true;
      resolve([]);
      return;
    }
    tracked.forEach((settled, index) => {
      settled.then((result) => {
        results[index] = result;
        maybeFinish();
      });
    });
  });

  return { first, all: Promise.all(tracked) };
}
