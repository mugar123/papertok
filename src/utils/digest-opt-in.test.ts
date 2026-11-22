import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestChain, deliverWelcomeYes, legacyFlagSettles, optInAttemptStep, readAnswerApplies, saveSendsNothing } from './digest-opt-in.ts';

const failure = (code: string, status = 0) => ({ code, status });
const NETWORK = failure('EMAIL_UNAVAILABLE');
const TIMEOUT = failure('EMAIL_TIMEOUT');
const ACCOUNT_CHANGED = failure('EMAIL_ACCOUNT_CHANGED', 401);
const retries = (step: ReturnType<typeof optInAttemptStep>) => typeof step === 'object';

test('a welcome yes is tried again three times when the failure may pass, then fails', () => {
  for (const passing of [NETWORK, TIMEOUT, failure('EMAIL_UNAVAILABLE', 503), failure('EMAIL_NOT_CONFIGURED', 503), failure('EMAIL_UNAVAILABLE', 502)]) {
    assert.deepEqual([1, 2, 3].map(attempts => retries(optInAttemptStep(passing, attempts))), [true, true, true], JSON.stringify(passing));
    assert.equal(optInAttemptStep(passing, 4), 'fail');
  }
});

test('a welcome yes the server refuses fails at once, an answer ends it, and an account change drops it', () => {
  for (const status of [400, 401, 403, 405, 409, 413]) {
    assert.equal(optInAttemptStep(failure('EMAIL_REFUSED', status), 1), 'fail', String(status));
  }
  // A build with no Worker address never reaches a server.
  assert.equal(optInAttemptStep(failure('EMAIL_NOT_CONFIGURED'), 1), 'fail');
  assert.equal(optInAttemptStep(null, 1), 'done');
  assert.equal(optInAttemptStep(ACCOUNT_CHANGED, 1), 'drop');
});

// A delivery with scripted answers: each attempt takes the next one.
function scriptedDelivery(script: unknown[], current: () => boolean = () => true) {
  const waits: number[] = [];
  let attempts = 0;
  const result = deliverWelcomeYes({
    current,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    send: async () => {
      const next = script[attempts];
      attempts += 1;
      if (typeof next === 'string') return next;
      throw next;
    },
  });
  return { result, waits, attempts: () => attempts };
}

test('a request that never reached the server is sent again, and the answer of the retry is the one kept', async () => {
  const delivery = scriptedDelivery([NETWORK, failure('EMAIL_UNAVAILABLE', 503), 'created']);

  assert.deepEqual(await delivery.result, { answer: 'created' });
  assert.equal(delivery.attempts(), 3);
  assert.equal(delivery.waits.length, 2);
  assert.ok(delivery.waits[0] < delivery.waits[1], 'the waits grow');
});

test('a welcome yes is sent four times at most, and a refusal is sent once', async () => {
  const exhausted = scriptedDelivery([NETWORK, NETWORK, NETWORK, NETWORK, 'created']);
  assert.deepEqual(await exhausted.result, { failed: NETWORK });
  assert.equal(exhausted.attempts(), 4);

  const refusal = failure('EMAIL_ADDRESS_NOT_VERIFIED', 403);
  const refused = scriptedDelivery([refusal, 'created']);
  assert.deepEqual(await refused.result, { failed: refusal });
  assert.equal(refused.attempts(), 1);
});

test('once the account that said yes is no longer the one signed in, nothing more is sent and nothing is reported', async () => {
  // Signed out before the first attempt.
  const never = scriptedDelivery(['created'], () => false);
  assert.equal(await never.result, null);
  assert.equal(never.attempts(), 0);

  // Switched accounts during a wait between attempts.
  let signedIn = true;
  const stopped = scriptedDelivery([NETWORK, 'created'], () => signedIn);
  signedIn = false;
  assert.equal(await stopped.result, null);
  assert.equal(stopped.attempts(), 1, 'the retry was sent for an account no longer signed in');

  // The answer arrived for an account that had already changed.
  const dropped = scriptedDelivery([ACCOUNT_CHANGED, 'created']);
  assert.equal(await dropped.result, null);
  assert.equal(dropped.attempts(), 1);
});

test('a yes kept under the earlier welcome text is finished with on any answer and on a refusal no retry changes', () => {
  const account = { accountHasEmail: true };
  for (const outcome of ['created', 'on', 'declined']) assert.equal(legacyFlagSettles({ outcome }, account), true, outcome);
  assert.equal(legacyFlagSettles({ error: failure('EMAIL_ADDRESS_NOT_VERIFIED', 403) }, account), true);
  assert.equal(legacyFlagSettles({ error: failure('EMAIL_FOLLOWS_REQUIRED', 409) }, account), true);
  // No address on the account: the server can never send it anything.
  assert.equal(legacyFlagSettles({ error: failure('EMAIL_AUTH_REQUIRED', 401) }, { accountHasEmail: false }), true);
});

test('a yes kept under the earlier welcome text stays for the next session when the failure may pass', () => {
  const account = { accountHasEmail: true };
  // An expired session on an account that has an address.
  assert.equal(legacyFlagSettles({ error: failure('EMAIL_AUTH_REQUIRED', 401) }, account), false);
  // A Worker from before the route, a server error, a timeout, no connection.
  for (const passing of [failure('EMAIL_METHOD_NOT_ALLOWED', 405), failure('EMAIL_PROVIDER_RATE_LIMIT', 429), failure('EMAIL_UNAVAILABLE', 503), failure('EMAIL_UNAVAILABLE', 502), TIMEOUT, NETWORK]) {
    assert.equal(legacyFlagSettles({ error: passing }, account), false, JSON.stringify(passing));
  }
  assert.equal(legacyFlagSettles({ error: ACCOUNT_CHANGED }, { accountHasEmail: false }), false);
  assert.equal(legacyFlagSettles({ error: failure('EMAIL_ORIGIN_NOT_ALLOWED', 403) }, account), false);
});

test('a read is shown only when no write was waiting when it started and none was queued while it ran', () => {
  assert.equal(readAnswerApplies({ pendingAtStart: 0, epochAtStart: 3, epochNow: 3 }), true);
  assert.equal(readAnswerApplies({ pendingAtStart: 1, epochAtStart: 3, epochNow: 3 }), false);
  assert.equal(readAnswerApplies({ pendingAtStart: 0, epochAtStart: 3, epochNow: 4 }), false);
});

test('a save that keeps the email off is sent unless the server is known to hold it off and no welcome yes is on its way', () => {
  const off = { enabled: false, serverEnabled: false, welcomePending: false };
  assert.equal(saveSendsNothing(off), true);
  // An Off during a welcome delivery must reach the server, so it wins.
  assert.equal(saveSendsNothing({ ...off, welcomePending: true }), false);
  // No server answer shown yet: the state is unknown, so the Off is sent.
  assert.equal(saveSendsNothing({ ...off, serverEnabled: null }), false);
  // The reader's unsubscribe, and any save that turns the email on.
  assert.equal(saveSendsNothing({ ...off, serverEnabled: true }), false);
  assert.equal(saveSendsNothing({ ...off, enabled: true }), false);
});

// A request the test settles by hand, to place it against the others.
function held<Result>() {
  let settle!: { resolve: (value: Result) => void; reject: (error: unknown) => void };
  const promise = new Promise<Result>((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('an Off made while the welcome yes is in flight is sent after it and its answer is the last one shown', async () => {
  const chain = createRequestChain();
  const optIn = held<string>();
  const shown: string[] = [];
  const sent: string[] = [];

  const first = chain.run(async () => {
    sent.push('opt-in');
    shown.push(await optIn.promise);
  });
  const second = chain.run(async () => {
    sent.push('off');
    shown.push('off');
  });
  await turn();
  assert.deepEqual(sent, ['opt-in'], 'the Off left before the opt-in was answered');

  optIn.resolve('created');
  await Promise.all([first, second]);

  assert.deepEqual(sent, ['opt-in', 'off']);
  assert.deepEqual(shown, ['created', 'off']);
});

test('a failed request does not hold back the ones queued after it, and its error reaches its own caller', async () => {
  const chain = createRequestChain();
  const failing = chain.run(async () => { throw new Error('offline'); });
  const next = chain.run(async () => 'saved');

  await assert.rejects(failing, /offline/);
  assert.equal(await next, 'saved');
});

test('a read that overlaps a write is not shown, and one made after the writes settled is', async () => {
  const chain = createRequestChain();
  // Started with nothing pending; a write is queued while it runs.
  const early = chain.mark();
  assert.equal(chain.readApplies(early), true);
  const write = held<string>();
  const writing = chain.run(() => write.promise);
  assert.equal(chain.readApplies(early), false);

  // Started while the write is in flight.
  const during = chain.mark();
  write.resolve('saved');
  await writing;
  assert.equal(chain.readApplies(during), false);

  await chain.idle();
  const after = chain.mark();
  assert.equal(chain.readApplies(after), true);
});
