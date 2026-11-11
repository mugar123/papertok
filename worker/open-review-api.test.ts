import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerEnv } from './env.ts';
import { fetchOpenReviewNote } from './open-review-api.ts';

// Synthetic responses. The login contract is the one OpenReview's own Python
// client uses (`POST /login` with `{ id, password }`, answered `{ token }`,
// then `Authorization: Bearer`); the notes are shaped like `/notes/search`
// answers. None of it was observed live: OpenReview refuses this project's
// anonymous requests with a bot check, which is why the Worker signs in.

interface Call { method: string; url: string; authorization: string | null; body: unknown }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Each test signs in under its own username: the Worker keeps one session per
// account for the life of its isolate, which here is the whole test run.
let accounts = 0;
function account(): WorkerEnv {
  accounts += 1;
  return { OPENREVIEW_USERNAME: `reader${accounts}@papertok.test`, OPENREVIEW_PASSWORD: 'not-a-real-password' };
}

async function withOpenReview<Result>(answer: (call: Call, calls: Call[]) => Response, run: (calls: Call[]) => Promise<Result>) {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const call: Call = {
      method: init?.method || 'GET',
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return answer(call, calls);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const SUBMISSION = {
  id: '5pShDP8LSm',
  forum: '5pShDP8LSm',
  domain: 'ICLR.cc/2026/Workshop/AIWILD',
  content: { title: { value: 'Position: AI Development Should Prioritize Cognitive Security' } },
};

const signedIn = (token = 'token-1') => (call: Call) => (call.url.endsWith('/login') ? json({ token }) : null);

test('signs in once, asks for the note with the token, and reuses the session', async () => {
  const env = account();
  await withOpenReview(
    call => signedIn()(call) ?? json({ notes: [SUBMISSION] }),
    async calls => {
      assert.equal((await fetchOpenReviewNote(env, '5pShDP8LSm'))?.id, '5pShDP8LSm');
      assert.equal((await fetchOpenReviewNote(env, '5pShDP8LSm'))?.id, '5pShDP8LSm');
      assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
        'POST https://api2.openreview.net/login',
        'GET https://api2.openreview.net/notes?id=5pShDP8LSm',
        'GET https://api2.openreview.net/notes?id=5pShDP8LSm',
      ]);
      assert.deepEqual(calls[0].body, { id: env.OPENREVIEW_USERNAME, password: env.OPENREVIEW_PASSWORD });
      assert.equal(calls[0].authorization, null);
      assert.equal(calls[1].authorization, 'Bearer token-1');
    },
  );
});

const countingLogins = (notes: (call: Call) => Response) => {
  let logins = 0;
  return (call: Call) => {
    if (!call.url.endsWith('/login')) return notes(call);
    logins += 1;
    return json({ token: `token-${logins}` });
  };
};

test('a kept token OpenReview no longer accepts is replaced by one fresh sign-in', async () => {
  const env = account();
  await withOpenReview(
    countingLogins(call => (call.authorization === 'Bearer token-1' && call.url.includes('second') ? json({ name: 'TokenExpiredError', status: 401 }, 401) : json({ notes: [SUBMISSION] }))),
    async calls => {
      await fetchOpenReviewNote(env, '5pShDP8LSm');
      // The session's token is refused on the next lookup.
      assert.equal(await fetchOpenReviewNote(env, 'secondNote1'), null);
      assert.deepEqual(calls.map(call => call.authorization), [null, 'Bearer token-1', 'Bearer token-1', null, 'Bearer token-2']);
    },
  );
});

test('a token issued for this lookup and refused is a failure, not a second sign-in', async () => {
  const env = account();
  await withOpenReview(
    call => signedIn()(call) ?? json({ name: 'ForbiddenError', status: 401 }, 401),
    async calls => {
      await assert.rejects(fetchOpenReviewNote(env, '5pShDP8LSm'), (error: Error & { status?: number }) => error.status === 401);
      assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
    },
  );
});

test('a token is replaced before the hour it lasts is over, without waiting for a refusal', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-11T12:00:00Z') });
  const env = account();
  await withOpenReview(
    countingLogins(() => json({ notes: [SUBMISSION] })),
    async calls => {
      await fetchOpenReviewNote(env, '5pShDP8LSm');
      t.mock.timers.tick(49 * 60_000);
      await fetchOpenReviewNote(env, '5pShDP8LSm');
      assert.equal(calls.filter(call => call.url.endsWith('/login')).length, 1, 'still the first token at 49 minutes');
      t.mock.timers.tick(2 * 60_000);
      await fetchOpenReviewNote(env, '5pShDP8LSm');
      assert.deepEqual(calls.map(call => call.authorization), [null, 'Bearer token-1', 'Bearer token-1', null, 'Bearer token-2']);
    },
  );
});

test('an id OpenReview does not hold, a reply, an imported record and an archive copy are no paper', async () => {
  const env = account();
  const answers: Record<string, () => Response> = {
    missingNote1: () => json({ name: 'NotFoundError', status: 404 }, 404),
    emptyList12: () => json({ notes: [] }),
    replyNote12: () => json({ notes: [{ id: 'replyNote12', forum: '5pShDP8LSm', replyto: '5pShDP8LSm' }] }),
    dblpRecord1: () => json({ notes: [{ id: 'dblpRecord1', forum: 'dblpRecord1', domain: 'DBLP.org/2026' }] }),
    archiveCopy: () => json({ notes: [{ id: 'archiveCopy', forum: 'archiveCopy', domain: 'OpenReview.net/Archive' }] }),
  };
  await withOpenReview(
    call => signedIn()(call) ?? answers[new URL(call.url).searchParams.get('id')!](),
    async calls => {
      for (const id of Object.keys(answers)) assert.equal(await fetchOpenReviewNote(env, id), null, id);
      assert.equal(calls.every(call => call.url.startsWith('https://api2.openreview.net/')), true, 'only the newer API is asked');
    },
  );
});

test('without an account nothing is asked, and the failure says so', async () => {
  await withOpenReview(
    () => json({ notes: [SUBMISSION] }),
    async calls => {
      await assert.rejects(fetchOpenReviewNote({}, '5pShDP8LSm'), { code: 'OPENREVIEW_NOT_CONFIGURED' });
      await assert.rejects(fetchOpenReviewNote({ OPENREVIEW_USERNAME: 'only-a-name@papertok.test' }, '5pShDP8LSm'), { code: 'OPENREVIEW_NOT_CONFIGURED' });
      assert.deepEqual(calls, []);
    },
  );
});

test('a refused sign-in fails without a relayed status and is not tried again for a minute', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-11T12:00:00Z') });
  const env = account();
  let refuse = true;
  const failed = (error: Error & { status?: number; code?: string }) => error.code === 'OPENREVIEW_SIGN_IN_FAILED' && error.status === undefined;
  await withOpenReview(
    call => {
      if (call.url.endsWith('/login')) return refuse ? json({ name: 'Error', message: 'Invalid username or password', status: 400 }, 400) : json({ token: 'token-1' });
      return json({ notes: [SUBMISSION] });
    },
    async calls => {
      await assert.rejects(fetchOpenReviewNote(env, '5pShDP8LSm'), failed);
      assert.equal(calls.length, 1, 'the note is not asked for without a session');

      // The password was fixed meanwhile; the refusal is still remembered.
      refuse = false;
      t.mock.timers.tick(59_000);
      await assert.rejects(fetchOpenReviewNote(env, '5pShDP8LSm'), failed);
      assert.equal(calls.length, 1, 'OpenReview is not sent the credentials again inside the minute');

      t.mock.timers.tick(2_000);
      assert.equal((await fetchOpenReviewNote(env, '5pShDP8LSm'))?.id, '5pShDP8LSm');
      assert.deepEqual(calls.map(call => call.method), ['POST', 'POST', 'GET']);
    },
  );
});

test('a sign-in told to wait longer than a minute waits that long, and a page instead of JSON is a refusal too', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-11T12:00:00Z') });
  const limited = account();
  await withOpenReview(
    () => new Response('{}', { status: 429, headers: { 'retry-after': '600' } }),
    async calls => {
      await assert.rejects(fetchOpenReviewNote(limited, '5pShDP8LSm'), { code: 'OPENREVIEW_SIGN_IN_FAILED' });
      t.mock.timers.tick(599_000);
      await assert.rejects(fetchOpenReviewNote(limited, '5pShDP8LSm'), { code: 'OPENREVIEW_SIGN_IN_FAILED' });
      assert.equal(calls.length, 1, 'not asked again before the ten minutes are over');
      t.mock.timers.tick(2_000);
      await assert.rejects(fetchOpenReviewNote(limited, '5pShDP8LSm'), { code: 'OPENREVIEW_SIGN_IN_FAILED' });
      assert.equal(calls.length, 2);
    },
  );

  const checked = account();
  await withOpenReview(
    () => new Response('<html>Verifying your browser</html>', { headers: { 'content-type': 'text/html' } }),
    async calls => {
      await assert.rejects(fetchOpenReviewNote(checked, '5pShDP8LSm'), { code: 'OPENREVIEW_SIGN_IN_FAILED' });
      await assert.rejects(fetchOpenReviewNote(checked, '5pShDP8LSm'), { code: 'OPENREVIEW_SIGN_IN_FAILED' });
      assert.equal(calls.length, 1, 'remembered like any refusal');
    },
  );
});

test('only what OpenReview shows everyone is returned, whatever the account may read', async () => {
  const env = account();
  const answers: Record<string, unknown> = {
    // A submission under double-blind review, as its own author is shown it.
    blindSubmit: {
      id: 'blindSubmit',
      forum: 'blindSubmit',
      domain: 'ICLR.cc/2027/Conference',
      readers: ['everyone'],
      content: {
        title: { value: 'A submission under review' },
        authors: { value: ['Ada Researcher'], readers: ['ICLR.cc/2027/Conference', 'ICLR.cc/2027/Conference/Submission1/Authors'] },
        authorids: { value: ['~Ada_Researcher1'], readers: ['ICLR.cc/2027/Conference', 'ICLR.cc/2027/Conference/Submission1/Authors'] },
        keywords: { value: ['review'], readers: ['everyone'] },
      },
    },
    // A note only its venue's committee may read.
    privateNote: { id: 'privateNote', forum: 'privateNote', domain: 'ICLR.cc/2027/Conference', readers: ['ICLR.cc/2027/Conference/Program_Chairs'], content: { title: { value: 'Not public' } } },
  };
  await withOpenReview(
    call => signedIn()(call) ?? json({ notes: [answers[new URL(call.url).searchParams.get('id')!]] }),
    async () => {
      const blind = await fetchOpenReviewNote(env, 'blindSubmit');
      assert.deepEqual(Object.keys(blind?.content || {}), ['title', 'keywords']);
      assert.equal(await fetchOpenReviewNote(env, 'privateNote'), null);
    },
  );
});

test('an account that needs a second factor cannot sign in unattended', async () => {
  const env = account();
  await withOpenReview(
    () => json({ mfaPending: true, mfaPendingToken: 'pending', mfaMethods: ['totp'] }),
    async calls => {
      await assert.rejects(fetchOpenReviewNote(env, '5pShDP8LSm'), { code: 'OPENREVIEW_SIGN_IN_FAILED' });
      assert.equal(calls.length, 1);
    },
  );
});

test('any other refusal of the note is a failure with its status and the wait OpenReview asked for', async () => {
  const env = account();
  await withOpenReview(
    call => signedIn()(call) ?? new Response('{}', { status: 429, headers: { 'retry-after': '17' } }),
    async () => {
      await assert.rejects(
        fetchOpenReviewNote(env, '5pShDP8LSm'),
        (error: Error & { status?: number; retryAfter?: string }) => error.status === 429 && error.retryAfter === '17',
      );
    },
  );
});

test('the deadline covers the sign-in and the note together', async () => {
  const env = account();
  // Each answer arrives inside 60 ms; the two together do not.
  const slowly = (response: Response) => new Promise<Response>(resolve => { setTimeout(() => resolve(response), 40); });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
    void slowly(String(input).endsWith('/login') ? json({ token: 'token-1' }) : json({ notes: [SUBMISSION] })).then(resolve);
  });
  try {
    await assert.rejects(fetchOpenReviewNote(env, '5pShDP8LSm', 60), { name: 'TimeoutError' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
