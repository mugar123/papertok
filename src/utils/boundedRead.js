/**
 * A bound on how long the interface will wait for a read.
 *
 * Firestore reads have no client-side timeout. A read against a connection
 * that has stalled — not offline, where the SDK rejects at once, but open and
 * unanswered — leaves its promise pending indefinitely, and any screen whose
 * loading state only ends in `.then`/`.catch` sits on a skeleton forever with
 * no way out but a reload. Both reported stalls (the comment sheet, the
 * profile settings screen) have exactly that shape.
 *
 * A timeout is emphatically **not an answer**: it says nothing about whether
 * the data exists, so callers must treat it as a retryable failure and never
 * as a confirmed absence — the same rule `pendingIdRequests` enforces for
 * cache-served misses. `isReadTimeout` exists so a caller can tell this apart
 * from a genuine error such as a permission denial.
 *
 * The timers are injectable so the behaviour is testable without waiting in
 * real time.
 */
export const DEFAULT_READ_TIMEOUT_MS = 6000;

export class ReadTimedOutError extends Error {
  constructor(label = 'read') {
    super(`Timed out waiting for ${label}`);
    this.name = 'ReadTimedOutError';
    // Survives the structured-clone and cross-realm cases where `instanceof`
    // would not; callers check the flag, never the class.
    this.timedOut = true;
    this.label = label;
  }
}

export function isReadTimeout(error) {
  return Boolean(error && error.timedOut);
}

export function withReadTimeout(promise, options = {}) {
  const {
    ms = DEFAULT_READ_TIMEOUT_MS,
    label = 'read',
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new ReadTimedOutError(label));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimer(timer);
        // The underlying read is never cancelled — Firestore has no such
        // affordance — so a late answer simply arrives after the caller has
        // moved on, and must not resolve a promise already rejected.
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error) => {
        clearTimer(timer);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}
