import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { loadPaperTranslationService } from '../../tests/dom/app-modules.ts';
import type { PaperTranslationRequest } from '../utils/paper-translation-contract.ts';

const input: PaperTranslationRequest = {
  arxivId: '2611.00829',
  title: 'An estimate of stellar distances',
  abstract: 'We measure stellar distances using two independent methods.',
  language: 'ja',
};

test('translation settles while the ID token is still pending and never sends a late request', async t => {
  const app = await loadPaperTranslationService();
  t.after(() => app.close());
  const { requestPaperTranslation } = app.entry;
  const { auth } = await app.firebase();
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 502 }));
  const realTimeout = AbortSignal.timeout;
  let deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 25_000 ? deadline.signal : realTimeout(ms));

  for (const cause of ['timeout', 'cancel'] as const) {
    deadline = new AbortController();
    const caller = new AbortController();
    let giveToken: (token: string) => void = () => {};
    const getIdToken = t.mock.fn(() => new Promise<string>(resolve => { giveToken = resolve; }));
    auth.currentUser = { uid: 'reader-1', getIdToken };
    const result = requestPaperTranslation(input, caller.signal);
    assert.equal(getIdToken.mock.callCount(), 1);

    if (cause === 'timeout') deadline.abort(new DOMException('Deadline reached', 'TimeoutError'));
    else caller.abort();

    try {
      assert.deepEqual(await Promise.race([result, setImmediate('still waiting for the token')]), {
        code: cause === 'timeout' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
      });
    } finally {
      giveToken('late-token');
      await result;
    }
    await setImmediate();
    assert.equal(fetch.mock.callCount(), 0);
  }
});

test('translation never sends the outgoing account token after the Firebase account changes', async t => {
  const app = await loadPaperTranslationService();
  t.after(() => app.close());
  const { requestPaperTranslation } = app.entry;
  const { auth } = await app.firebase();
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 502 }));
  const nextAccount = { uid: 'reader-2', getIdToken: async () => 'next-token' };

  for (const next of [nextAccount, null]) {
    let giveToken: (token: string) => void = () => {};
    const getIdToken = t.mock.fn(() => new Promise<string>(resolve => { giveToken = resolve; }));
    auth.currentUser = { uid: 'reader-1', getIdToken };
    const result = requestPaperTranslation(input, new AbortController().signal);
    assert.equal(getIdToken.mock.callCount(), 1);
    auth.currentUser = next;
    giveToken('outgoing-token');

    assert.deepEqual(await result, { code: 'AI_AUTH_REQUIRED' });
    assert.equal(fetch.mock.callCount(), 0);
  }
});
