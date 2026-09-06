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
 * A stall has **two shapes**, and missing the second one is what kept the
 * comment sheet ending in "could not be loaded":
 *
 *   1. The read never settles. That is what `withReadTimeout` bounds.
 *   2. The read settles — as a *rejection* — ten seconds later, because the
 *      SDK gave up before we did. `isTransientReadError` is what tells that
 *      apart from a real refusal, and `patientRead` is what keeps waiting.
 *
 * The timers, the online probe and its subscription are all injectable so the
 * behaviour is testable without waiting in real time or touching a browser.
 */
export const DEFAULT_READ_TIMEOUT_MS = 6000;
/** First pause after a transient rejection; doubles up to the cap below. */
export const DEFAULT_RETRY_DELAY_MS = 800;
export const MAX_RETRY_DELAY_MS = 8000;
/**
 * How long an attempt may go unanswered before the stream it rides is
 * presumed dead and rebuilt (see utils/streamRecovery.js).
 *
 * Measured: a healthy cold read answers in 290–450 ms and a warm one in
 * 130–230 ms, and a read against a silent stream answers never — there is
 * no in-between worth waiting for. Three seconds is an order of magnitude
 * above healthy and still inside every budget on the reads that gate a
 * screen (5 s for the feed's profile, 7 s for the account, 6 s here), so the
 * retry that follows the kick lands before any of them says "stalled".
 */
export const DEFAULT_STALL_MS = 3000;

let defaultStallRecovery = null;

/**
 * Registers what a stalled read should do to the transport — in the app, the
 * Firestore stream kick wired up in services/firebase.js. One registration
 * for every `patientRead`, so a screen never has to know which stream it is
 * on; a read that passes `onStall` of its own overrides it. Returns the
 * unregister function, which tests use.
 */
export function registerStallRecovery(recover) {
  defaultStallRecovery = typeof recover === 'function' ? recover : null;
  return () => {
    if (defaultStallRecovery === recover) defaultStallRecovery = null;
  };
}

export class ReadTimedOutError extends Error {
  constructor(label = 'read', cause) {
    super(`Timed out waiting for ${label}`, cause ? { cause } : undefined);
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

/**
 * Firestore statuses that mean "not now", never "not ever".
 *
 * This list is the fix for a measured bug, so it is worth spelling out. The
 * SDK carries a hardcoded ten-second `ONLINE_STATE_TIMEOUT`: against a stalled
 * connection it spends exactly that long deciding, then **rejects** every
 * pending document read with `unavailable` — "Failed to get document because
 * the client is offline". Reproduced against production: the stub read
 * rejected at 10 003 ms, and the two reads after it rejected in 1 ms and 0 ms,
 * because by then the client had latched itself offline.
 *
 * Treating that as a deterministic failure is what turned a stalled channel
 * into "the comments could not be loaded" — the screen blamed the server for
 * a connection that was merely late, and one tap later the same read answered
 * in 220 ms. `unavailable` is the most retryable error Firestore produces, and
 * it must be met with patience, not a verdict.
 *
 * Everything absent from this list — `permission-denied`, `unauthenticated`,
 * `not-found`, `invalid-argument`, `failed-precondition`, `unimplemented`, a
 * plain `TypeError` — still fails immediately. Those will not change on a
 * retry, and burning a budget on them only delays an honest error.
 */
const TRANSIENT_READ_CODES = Object.freeze([
  'unavailable',
  'deadline-exceeded',
  'internal',
  'cancelled',
  'aborted',
  'resource-exhausted',
  'unknown',
]);

export function isTransientReadError(error) {
  if (!error) return false;
  if (error.timedOut === true) return true;
  // A service that knows its own error is a "not now" says so on the error
  // itself (PublicListUnavailableError): the cache answered instead of the
  // server, and asking again is the right response, not a verdict.
  if (error.retryable === true) return true;
  return TRANSIENT_READ_CODES.includes(error.code);
}

/**
 * "The browser says there is no network." Deliberately narrow: `onLine` false
 * is trustworthy, `onLine` true means very little, and an environment without
 * `navigator` is never assumed to be offline.
 */
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * How long a read has to have been waiting before a screen may call it slow.
 *
 * `onSlow` fires at every intermediate timeout AND at every transient
 * rejection, and the second of those can be instantaneous: a cache-served
 * absence (src/utils/cacheAuthority.js) rejects in about half a millisecond
 * once the client has latched itself offline. Measured on the My-comments
 * page, `onSlow#1` landed at 2 ms — so the skeleton was replaced by "this is
 * taking longer than usual" inside the first frame, before anything had taken
 * long. Below the read budget on purpose, so a read that genuinely times out
 * still gets its words at the first timeout and not one attempt later.
 */
export const SLOW_NOTICE_AFTER_MS = 1200;

/**
 * The status an `onSlow` notification is worth showing, or `null` for "say
 * nothing yet, the skeleton is still the honest answer".
 *
 * Being offline is exempt: the browser's own verdict needs no waiting to be
 * true, and "there seems to be no connection" is the more useful sentence the
 * instant it is available.
 */
export function slowNoticeStatus(elapsedMs, info, threshold = SLOW_NOTICE_AFTER_MS) {
  if (info?.offline) return 'offline';
  return elapsedMs >= threshold ? 'slow' : null;
}

/** Wakes a waiting read the moment the browser regains a network. */
function subscribeToOnline(listener) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  window.addEventListener('online', listener);
  return () => window.removeEventListener('online', listener);
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
 * - `onSlow(attemptNumber, { offline })` fires at each intermediate timeout,
 *   and again whenever an attempt dies of a transient error, so the interface
 *   can say "this is taking longer than usual" — or "there is no connection",
 *   which is a different and more useful truth.
 * - When every attempt has timed out the promise rejects with
 *   `ReadTimedOutError`, but the attempts are not abandoned: the first one to
 *   answer afterwards is handed to `onLateResult`, so a stall that ends at
 *   nine seconds heals the screen at nine seconds with no user action.
 * - A **transient rejection never settles this promise**. The attempt is dead,
 *   so nothing is left racing and there is nothing to wait for: a fresh one is
 *   scheduled behind an exponential backoff instead. The backoff is not
 *   decoration — once the SDK has latched itself offline it rejects in under a
 *   millisecond, and without a pause the whole budget burns in microseconds.
 *   The retry loop also wakes early on the browser's `online` event, and it
 *   keeps running after the promise has rejected as timed out, which is what
 *   delivers the eventual answer through `onLateResult`.
 * - A real rejection (permission denied, unsupported) still fails
 *   immediately — see `isTransientReadError` for which is which.
 *
 * `signal` is how a caller stops all of it. React effects should abort on
 * cleanup: the retry loop outlives the promise on purpose, so an unmounted
 * screen that never aborts would keep re-reading for the life of the tab.
 */
export function patientRead(makeAttempt, options = {}) {
  const {
    attempts = 2,
    ms = DEFAULT_READ_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxRetryDelayMs = MAX_RETRY_DELAY_MS,
    label = 'read',
    onSlow,
    onLateResult,
    signal,
    /**
     * "Is this value an answer?" A cache-served emptiness is not one (see
     * utils/cacheAuthority.js), and the stream kick below produces exactly
     * that for every read it flushes. A value the caller cannot act on is
     * treated like a transient rejection: the screen may say slow, and a
     * fresh read is queued — never resolved, never handed to `onLateResult`.
     */
    isAnswer = () => true,
    stallMs = DEFAULT_STALL_MS,
    onStall = defaultStallRecovery,
    checkOffline = isOffline,
    subscribeOnline = subscribeToOnline,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let lateDelivered = false;
    let stopped = false;
    let timer = null;
    let retryTimer = null;
    let stallTimer = null;
    let releaseOnline = null;
    let retries = 0;
    let lastTransient = null;

    /** Ends every pending timer and listener. Nothing runs after this. */
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
      clearTimer(retryTimer);
      clearTimer(stallTimer);
      timer = null;
      retryTimer = null;
      stallTimer = null;
      if (releaseOnline) {
        releaseOnline();
        releaseOnline = null;
      }
    };

    const succeed = (value) => {
      if (settled) {
        // The main promise already rejected as timed out; this is the late
        // answer the caller still wants exactly once.
        if (timedOut && !lateDelivered && onLateResult) {
          lateDelivered = true;
          stop();
          onLateResult(value);
        }
        return;
      }
      settled = true;
      stop();
      resolve(value);
    };

    const failForReal = (error) => {
      // A deterministic error ends the retry loop even when the promise has
      // already rejected as timed out: no amount of asking will change it.
      stop();
      if (settled) return;
      settled = true;
      reject(error);
    };

    const notifySlow = (attemptNumber) => {
      if (!onSlow) return;
      onSlow(attemptNumber, { offline: checkOffline() });
    };

    const scheduleRetry = (attemptNumber) => {
      if (stopped) return;
      // Past the timeout verdict, the loop only exists to feed `onLateResult`.
      // With nobody listening, or the answer already delivered, it is waste.
      if (settled && (!onLateResult || lateDelivered)) {
        stop();
        return;
      }
      retries += 1;
      const backoff = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** (retries - 1)));
      // No network at all: go straight to the longest pause and let the
      // `online` event do the waking.
      const delay = checkOffline() ? maxRetryDelayMs : backoff;
      clearTimer(retryTimer);
      retryTimer = setTimer(() => {
        retryTimer = null;
        launch(attemptNumber);
      }, delay);
      armOnlineWake(attemptNumber);
    };

    function armOnlineWake(attemptNumber) {
      if (releaseOnline || stopped) return;
      releaseOnline = subscribeOnline(() => {
        if (stopped) return;
        clearTimer(retryTimer);
        retryTimer = null;
        if (releaseOnline) {
          releaseOnline();
          releaseOnline = null;
        }
        launch(attemptNumber);
      });
    }

    function launch(attemptNumber) {
      if (stopped) return;
      // Synchronously: the read must be on the wire before the timer starts
      // counting against it. A sync throw is just a failed attempt.
      let attemptPromise;
      try {
        attemptPromise = Promise.resolve(makeAttempt());
      } catch (error) {
        attemptPromise = Promise.reject(error);
      }
      const notNow = (error) => {
        // "Not now", not "not ever". This attempt is gone, so nothing is left
        // racing for it — ask again, after a pause.
        lastTransient = error;
        notifySlow(attemptNumber);
        scheduleRetry(attemptNumber);
      };
      attemptPromise.then((value) => {
        clearTimer(stallTimer);
        stallTimer = null;
        if (settled && !timedOut) return;
        if (!isAnswer(value)) {
          notNow(null);
          return;
        }
        succeed(value);
      }, (error) => {
        clearTimer(stallTimer);
        stallTimer = null;
        if (isReadTimeout(error)) return;
        if (!isTransientReadError(error)) {
          failForReal(error);
          return;
        }
        notNow(error);
      });
      // The stream watch. An attempt still unanswered at `stallMs` while the
      // browser says it has a network is, by measurement, riding a dead
      // stream (utils/streamRecovery.js), and no amount of waiting or
      // re-asking on that same stream changes it. The recovery flushes the
      // attempt — as a transient, or as a value `isAnswer` refuses — and the
      // retry that follows is the first read on the rebuilt stream.
      if (onStall && stallMs > 0 && stallMs < ms) {
        clearTimer(stallTimer);
        stallTimer = setTimer(() => {
          stallTimer = null;
          if (stopped || checkOffline()) return;
          try {
            const outcome = onStall(attemptNumber);
            if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {});
          } catch {
            // A recovery that throws has nothing to add to a read that is
            // already being waited out.
          }
        }, stallMs);
      }
      clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        if (stopped) return;
        if (settled) {
          // Past the verdict, this is the healing loop's own read, and it has
          // not come back either. Returning here would end the loop after a
          // single try: measured against a wedged client, that is the
          // difference between a screen that recovers and one that never does.
          scheduleRetry(attemptNumber);
          return;
        }
        if (attemptNumber < attempts) {
          notifySlow(attemptNumber);
          launch(attemptNumber + 1);
          return;
        }
        settled = true;
        timedOut = true;
        // Deliberately no `stop()`: the attempts still racing, and the retry
        // loop, are what heal the screen through `onLateResult`.
        reject(new ReadTimedOutError(label, lastTransient));
        // A stall has two shapes, and the budget can be spent on either. This
        // is the one where the reads simply never come back: the attempts
        // still racing are hostages of the same dead connection, so waiting on
        // them alone would leave the screen on "still trying" forever. Keep
        // asking, behind the same backoff, so a connection that returns is met
        // with a fresh read instead of a promise nobody can keep.
        scheduleRetry(attemptNumber);
      }, ms);
    }

    if (signal) {
      // Never settles once aborted — the caller is gone, and rejecting would
      // only push an error into a screen that no longer exists.
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener('abort', stop, { once: true });
    }

    launch(1);
  });
}
