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

/**
 * A read with patience: bounded attempts, a slow-notice instead of a false
 * failure, and late answers that still count.
 *
 * Measured on the comments sheet: a healthy read answers in 60–390 ms, and a
 * read against a silent connection answers *never* — there is no in-between.
 * A single hard timeout turned that second case into "the comments could not
 * be loaded", which was a lie: the server had not failed, the answer was
 * merely late, and proof of that was the instant success one tap later.
 *
 * So instead of one guillotine:
 *
 * - Each timeout launches another attempt while every earlier one keeps
 *   racing — whichever answers first wins. Re-asking is cheap (these are
 *   one-document reads) and covers the cases where a fresh request genuinely
 *   helps, like an expired auth token.
 * - `onSlow` fires at each intermediate timeout so the interface can say
 *   "this is taking longer than usual" — which is the truth — rather than
 *   blaming the server.
 * - When every attempt has timed out the promise rejects with
 *   `ReadTimedOutError`, but the attempts are not abandoned: the first one to
 *   answer afterwards is handed to `onLateResult`, so a stall that ends at
 *   nine seconds heals the screen at nine seconds with no user action.
 * - A real rejection (permission denied, unsupported) fails immediately —
 *   deterministic failures do not deserve patience.
 */
export function patientRead(makeAttempt, options = {}) {
  const {
    attempts = 2,
    ms = DEFAULT_READ_TIMEOUT_MS,
    label = 'read',
    onSlow,
    onLateResult,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let lateDelivered = false;
    let timer = null;

    const succeed = (value) => {
      if (settled) {
        // The main promise already rejected as timed out; this is the late
        // answer the caller still wants exactly once.
        if (timedOut && !lateDelivered && onLateResult) {
          lateDelivered = true;
          onLateResult(value);
        }
        return;
      }
      settled = true;
      clearTimer(timer);
      resolve(value);
    };

    const failForReal = (error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      reject(error);
    };

    const launch = (attemptNumber) => {
      // Synchronously: the read must be on the wire before the timer starts
      // counting against it. A sync throw is just a failed attempt.
      let attemptPromise;
      try {
        attemptPromise = Promise.resolve(makeAttempt());
      } catch (error) {
        attemptPromise = Promise.reject(error);
      }
      attemptPromise.then(succeed, (error) => {
        if (!isReadTimeout(error)) failForReal(error);
      });
      timer = setTimer(() => {
        if (settled) return;
        if (attemptNumber < attempts) {
          if (onSlow) onSlow(attemptNumber);
          launch(attemptNumber + 1);
          return;
        }
        settled = true;
        timedOut = true;
        reject(new ReadTimedOutError(label));
      }, ms);
    };

    launch(1);
  });
}
