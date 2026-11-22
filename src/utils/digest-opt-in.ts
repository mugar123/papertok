// The decisions around handing a welcome yes to the server
// (`POST /notifications/opt-in`) and around which server answer the app shows.
// No React and no network here: EmailNotificationsContext wires them.

type RequestError = { code?: unknown; status?: unknown } | null | undefined;

const statusOf = (error: unknown) => Number((error as RequestError)?.status) || 0;
const codeOf = (error: unknown) => String((error as RequestError)?.code ?? '');

/** How long to wait before the second, third and fourth attempt. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

/**
 * What follows one attempt to hand over a welcome yes: `done` when the server
 * answered, a wait before the next attempt when the failure may pass (no
 * answer at all, a timeout, or a 5xx), `fail` when it cannot (the server
 * refused the request, or the attempts ran out), and `drop` when the account
 * changed meanwhile, which is nobody's failure to report.
 */
export function optInAttemptStep(error: unknown, attemptsMade: number): 'done' | 'fail' | 'drop' | { retryInMs: number } {
  if (error === null || error === undefined) return 'done';
  if (codeOf(error) === 'EMAIL_ACCOUNT_CHANGED') return 'drop';
  const status = statusOf(error);
  // A build with no Worker address fails the same way every time.
  const mayPass = status >= 500 || (status === 0 && codeOf(error) !== 'EMAIL_NOT_CONFIGURED');
  const retryInMs = RETRY_DELAYS_MS[attemptsMade - 1];
  return mayPass && retryInMs !== undefined ? { retryInMs } : 'fail';
}

/**
 * Hands a welcome yes to the server: one `send` per attempt, with the waits
 * `optInAttemptStep` asks for in between. `current` says the account that said
 * yes is still the one shown and signed in; once it is not, nothing more is
 * sent. Resolves with the server's answer, with the error of a failure that
 * will not pass, or with `null` when the yes was dropped.
 */
export async function deliverWelcomeYes<Answer>({ send, current, wait }: {
  send: () => Promise<Answer>;
  current: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<{ answer: Answer } | { failed: unknown } | null> {
  for (let attemptsMade = 1; ; attemptsMade += 1) {
    if (!current()) return null;
    let failure: unknown = null;
    let answer: Answer | undefined;
    try {
      answer = await send();
    } catch (error) {
      failure = error ?? new Error('The opt-in request failed');
    }
    const step = optInAttemptStep(failure, attemptsMade);
    if (step === 'done') return { answer: answer as Answer };
    if (step === 'drop') return null;
    if (step === 'fail') return { failed: failure };
    await wait(step.retryInMs);
  }
}

/**
 * Whether a yes kept in the profile under the earlier welcome text
 * (`emailDigestOptIn`) is finished with: the server answered, whatever it
 * answered, or it refused in a way no later attempt changes: the address is
 * not proven (403), nothing the digest covers is followed (409), or the
 * account has no address at all (a 401 while it has none). Anything that may
 * pass keeps the flag for the next session: an expired session, an older
 * Worker (405), a 5xx, a timeout, no connection, a refused origin, or an
 * account change.
 */
export function legacyFlagSettles(result: { outcome: string } | { error: unknown }, { accountHasEmail }: { accountHasEmail: boolean }) {
  if ('outcome' in result) return true;
  const code = codeOf(result.error);
  if (code === 'EMAIL_ACCOUNT_CHANGED' || code === 'EMAIL_ORIGIN_NOT_ALLOWED') return false;
  const status = statusOf(result.error);
  return status === 403 || status === 409 || (status === 401 && !accountHasEmail);
}

/**
 * Whether the answer of a read of the preferences may be shown: only when no
 * write was waiting or in flight as the read started, and none was queued
 * while it ran. Otherwise the read may describe the server from before a
 * write whose own answer is the newer one.
 */
export function readAnswerApplies({ pendingAtStart, epochAtStart, epochNow }: { pendingAtStart: number; epochAtStart: number; epochNow: number }) {
  return pendingAtStart === 0 && epochAtStart === epochNow;
}

/**
 * Whether a save from Settings has nothing to send: it keeps the email off,
 * the last server answer shown for this account said it is off
 * (`serverEnabled`; `null` when no answer was shown), and no welcome yes is on
 * its way. Sending it would record a decision the reader did not make, and
 * the server would then decline a yes that is still waiting. While a welcome
 * yes is being delivered an Off is always sent, so it wins.
 */
export function saveSendsNothing({ enabled, serverEnabled, welcomePending }: { enabled: boolean; serverEnabled: boolean | null; welcomePending: boolean }) {
  return !enabled && serverEnabled === false && !welcomePending;
}

/**
 * One line for every write to `/notifications/*` from a tab: each `run` starts
 * once the tasks queued before it have settled, so the requests reach the
 * server, and their answers are shown, in the order the reader made them. A
 * read is not queued: it notes `mark()` as it starts and asks `readApplies`
 * before it shows its answer.
 */
export function createRequestChain() {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let epoch = 0;
  return {
    run<Result>(task: () => Promise<Result>): Promise<Result> {
      epoch += 1;
      pending += 1;
      const result = tail.then(task).finally(() => { pending -= 1; });
      tail = result.catch(() => undefined);
      return result;
    },
    /** Resolves once every task queued so far has settled. */
    idle: () => tail.then(() => undefined),
    mark: () => ({ pendingAtStart: pending, epochAtStart: epoch }),
    readApplies: (start: { pendingAtStart: number; epochAtStart: number }) => readAnswerApplies({ ...start, epochNow: epoch }),
  };
}
