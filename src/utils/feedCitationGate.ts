/**
 * Snapshot provider responses before admitting a feed page. The default budget
 * is for first-screen citations; callers with missing abstracts use a longer,
 * bounded wait. Results after the gate closes cannot enter this snapshot.
 */
export const CITATION_GATE_MAX_WAIT_MS = 1200;

/**
 * Settles `promises`, or gives up at `maxWaitMs`, whichever comes first.
 *
 * Resolves to one entry per promise, in order: its value if it arrived in
 * time, `null` if it did not. A rejection is a miss, not a throw — a source
 * being down is a feed without that source's numbers, never a feed that
 * fails to paint.
 *
 * The returned array is a snapshot. A value that lands after the cap does not
 * appear in it, because the caller has already painted with it by then; that
 * value reaches the reader through the late merge instead.
 *
 * An empty list resolves immediately rather than sitting out the timer, and
 * the timer is always cleared — a pending one would keep the process (and a
 * test run) alive past its work.
 */
export function awaitWithinGate<const T extends readonly unknown[]>(promises: T, options?: { maxWaitMs?: number }): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> | null }>;
export async function awaitWithinGate<T>(promises: Array<PromiseLike<T> | T>, { maxWaitMs = CITATION_GATE_MAX_WAIT_MS } = {}) {
  const list = Array.isArray(promises) ? promises : [];
  if (list.length === 0) return [];

  const slots = list.map((promise) => {
    const slot: { value: Awaited<T> | null; settled: boolean; done?: Promise<void>; closed?: boolean } = { value: null, settled: false };
    slot.done = Promise.resolve(promise).then(
      (value) => { if (!slot.closed) { slot.value = value; slot.settled = true; } },
      () => { slot.settled = true; },
    );
    return slot;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise((resolve) => { timer = setTimeout(resolve, maxWaitMs); });
  try {
    await Promise.race([Promise.all(slots.map((slot) => slot.done)), cap]);
  } finally {
    clearTimeout(timer);
  }

  // Close the slots before reading them, so a value resolving in the same
  // microtask queue as this read cannot half-land in the snapshot.
  slots.forEach((slot) => { slot.closed = true; });
  return slots.map((slot) => slot.value);
}
