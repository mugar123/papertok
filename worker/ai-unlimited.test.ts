import type { TestNamespace } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnlimitedAI } from './ai-explanation.ts';
import reportApi from './index.ts';

/**
 * Accounts the daily allowance does not apply to.
 *
 * Two things are being protected here and they pull in opposite directions. The
 * exemption has to actually work — an owner who cannot use their own product is
 * the reason it exists — and it has to be impossible to claim, which is why it
 * turns on the *verified* address and nothing else. An unverified email is a
 * string the account holder typed.
 *
 * What it deliberately does NOT lift is the global daily ceiling. That one is
 * not a product limit, it is the cost ceiling on the provider key.
 */

const ALLOWED = 'nicomg60@gmail.com,themugar123@gmail.com';

test('a verified address on the list is exempt', () => {
  assert.equal(
    hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, { uid: 'u1', email: 'nicomg60@gmail.com', emailVerified: true }),
    true,
  );
  assert.equal(
    hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, { uid: 'u2', email: 'themugar123@gmail.com', emailVerified: true }),
    true,
  );
});

test('the same address unverified is not', () => {
  // The one that matters. Without this the exemption is claimable by typing.
  assert.equal(
    hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, { uid: 'u3', email: 'nicomg60@gmail.com', emailVerified: false }),
    false,
  );
});

test('an address that is not on the list is not exempt', () => {
  assert.equal(
    hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, { uid: 'u4', email: 'someone@example.com', emailVerified: true }),
    false,
  );
  // Nor is a near-miss, however close.
  assert.equal(
    hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, { uid: 'u5', email: 'nicomg60@gmail.com.evil.test', emailVerified: true }),
    false,
  );
  assert.equal(
    hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, { uid: 'u6', email: 'xnicomg60@gmail.com', emailVerified: true }),
    false,
  );
});

test('spacing in the setting does not decide who is exempt', () => {
  assert.equal(
    hasUnlimitedAI(
      { AI_UNLIMITED_EMAILS: '  nicomg60@gmail.com ,, themugar123@gmail.com  ' },
      { uid: 'u7', email: 'themugar123@gmail.com', emailVerified: true },
    ),
    true,
  );
});

test('an unset or empty list exempts nobody', () => {
  const identity = { uid: 'u8', email: 'nicomg60@gmail.com', emailVerified: true };
  assert.equal(hasUnlimitedAI({}, identity), false);
  assert.equal(hasUnlimitedAI({ AI_UNLIMITED_EMAILS: '' }, identity), false);
  assert.equal(hasUnlimitedAI({ AI_UNLIMITED_EMAILS: '  , ,, ' }, identity), false);
  // And an account with no address cannot match an empty entry either.
  assert.equal(hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, { uid: 'u9', email: '', emailVerified: true }), false);
  assert.equal(hasUnlimitedAI({ AI_UNLIMITED_EMAILS: ALLOWED }, null), false);
});

// ---------------------------------------------------------------------------
// And what the Worker actually does with it.
// ---------------------------------------------------------------------------

/** A ledger that records the ceilings it was asked to enforce. */
function ceilingLedger() {
  const seen: Array<{ action: string; subjectLimit: number; globalLimit: number }> = [];
  return {
    seen,
    idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (_url: RequestInfo | URL, options?: RequestInit) => {
        const body = JSON.parse(options!.body as string);
        seen.push({ action: body.action, subjectLimit: body.subjectLimit, globalLimit: body.globalLimit });
        return new Response(JSON.stringify({ accepted: true, remaining: 993, subjectUsage: 7, globalUsage: 7 }));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'] & { seen: typeof seen };
}

function quotaEnv(ledger: TestNamespace | undefined, extra = {}) {
  return {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    AI_DAILY_USER_LIMIT: '10',
    AI_DAILY_GLOBAL_LIMIT: '1000',
    AI_UNLIMITED_EMAILS: ALLOWED,
    REQUEST_QUOTA_LEDGER: ledger as WorkerEnv['REQUEST_QUOTA_LEDGER'],
    ...extra,
  };
}

async function asAccount<Result>(email: string, emailVerified: boolean, callback: () => Promise<Result>) {
  const originalCaches = (globalThis as TestGlobals).caches;
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => (String((request as Request).url).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'owner-uid', email, emailVerified }), {
          headers: { 'content-type': 'application/json' },
        })
        : null),
      put: async (): Promise<unknown> => undefined,
    },
  };
  try {
    return await callback();
  } finally {
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

function quotaRequest() {
  return new Request('https://papertok-report-api.example/ai/quota', {
    headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' },
  });
}

test('GET /ai/quota tells an exempt account that it is exempt', async () => {
  const ledger = ceilingLedger();
  const response = await asAccount('nicomg60@gmail.com', true, () => reportApi.fetch(quotaRequest(), quotaEnv(ledger)));

  assert.equal(response.status, 200);
  const payload = await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>();
  assert.equal(payload.unlimited, true);
  // The per-user ceiling handed to the ledger is the global one: the ledger
  // still counts what the account spends, it just stops being what refuses it.
  assert.equal(ledger.seen[0].subjectLimit, 1000);
  assert.equal(ledger.seen[0].globalLimit, 1000);
});

test('everybody else still gets ten a day', async () => {
  const ledger = ceilingLedger();
  const response = await asAccount('someone@example.com', true, () => reportApi.fetch(quotaRequest(), quotaEnv(ledger)));

  const payload = await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>();
  assert.equal(payload.unlimited, undefined);
  assert.equal(payload.dailyLimit, 10);
  assert.equal(ledger.seen[0].subjectLimit, 10);
});

test('an unverified address on the list still gets ten a day', async () => {
  const ledger = ceilingLedger();
  const response = await asAccount('nicomg60@gmail.com', false, () => reportApi.fetch(quotaRequest(), quotaEnv(ledger)));

  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).dailyLimit, 10);
  assert.equal(ledger.seen[0].subjectLimit, 10);
});

test('the global ceiling is never lifted, for anyone', async () => {
  const ledger = ceilingLedger();
  await asAccount('nicomg60@gmail.com', true, () => reportApi.fetch(quotaRequest(), quotaEnv(ledger)));
  // The cost ceiling on the provider key. An exemption from this one is how a
  // runaway loop becomes a bill, so there is deliberately no way to ask for it.
  assert.equal(ledger.seen[0].globalLimit, 1000);
});
