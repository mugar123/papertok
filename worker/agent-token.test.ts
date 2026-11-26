import type { WorkerEnv } from './env.ts';
import type { TestNamespace } from './test-types.ts';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import { mintAgentToken, verifyAgentToken } from './agent-token.ts';
import reportApi from './index.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

const SECRET = 'test-only-agent-token-secret-of-32-bytes';
const NOW = Date.parse('2026-11-26T10:00:20.000Z');
const THIRTY_MINUTES = 30 * 60 * 1000;
const env: WorkerEnv = { MCP_AGENT_TOKEN_SECRET: SECRET };

const refused = { name: 'WorkerAuthError', code: 'AUTH_REQUIRED', status: 401 };
const notConfigured = { name: 'WorkerAuthError', code: 'AGENT_TOKEN_NOT_CONFIGURED', status: 503 };

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A token as the wire format describes it, signed here and not by the module:
// an HMAC-SHA-256 of `papertok-agent-token:v1:` and the payload segment.
async function signed(payload: unknown, { secret = SECRET, message = (segment: string) => `papertok-agent-token:v1:${segment}`, prefix = 'ptka1' } = {}) {
  const segment = base64Url(new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message(segment))));
  return `${prefix}.${segment}.${base64Url(signature)}`;
}

const claims = (extra: Record<string, unknown> = {}) => ({ uid: 'alice-uid', scopes: ['account:read'], iat: NOW / 1000 - 20, exp: NOW / 1000 + 600, ...extra });

test('a minted token names its account and scopes for thirty minutes', async () => {
  const { token, expiresAt } = await mintAgentToken(env, 'alice-uid', ['account:read'], NOW);
  assert.match(token, /^ptka1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt, Math.floor((NOW + THIRTY_MINUTES) / 1000));
  assert.deepEqual(await verifyAgentToken(token, env, NOW), { uid: 'alice-uid', scopes: ['account:read'] });
  assert.deepEqual(await verifyAgentToken(token, env, NOW + THIRTY_MINUTES - 1000), { uid: 'alice-uid', scopes: ['account:read'] });
  await assert.rejects(verifyAgentToken(token, env, NOW + THIRTY_MINUTES), refused);
  await assert.rejects(verifyAgentToken(token, env, NOW + 24 * 60 * 60 * 1000), refused);
});

test('a token signed as the format describes verifies, and one signed any other way does not', async () => {
  assert.deepEqual(await verifyAgentToken(await signed(claims()), env, NOW), { uid: 'alice-uid', scopes: ['account:read'] });
  for (const [why, token] of [
    ['another secret', await signed(claims(), { secret: 'another-secret-that-is-32-bytes-long!' })],
    ['a signature of the payload alone', await signed(claims(), { message: segment => segment })],
    ['a signature for another version', await signed(claims(), { message: segment => `papertok-agent-token:v2:${segment}` })],
    ['another prefix', await signed(claims(), { prefix: 'ptka2' })],
  ] as const) {
    await assert.rejects(verifyAgentToken(token, env, NOW), refused, why);
  }
});

test('a token changed after signing is refused', async () => {
  const { token } = await mintAgentToken(env, 'alice-uid', ['account:read'], NOW);
  const [prefix, payload, signature] = token.split('.');
  const mallory = base64Url(new TextEncoder().encode(JSON.stringify(claims({ uid: 'mallory-uid' }))));
  const flipped = (text: string, index: number) => `${text.slice(0, index)}${text[index] === 'A' ? 'B' : 'A'}${text.slice(index + 1)}`;
  // The last character of a 32-byte signature carries two bits no byte reads.
  const spare = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const respelled = `${signature.slice(0, -1)}${spare[spare.indexOf(signature.at(-1)!) ^ 1]}`;
  for (const [why, changed] of [
    ['another payload under the same signature', `${prefix}.${mallory}.${signature}`],
    ['one character of the payload', `${prefix}.${flipped(payload, 4)}.${signature}`],
    ['one character of the signature', `${prefix}.${payload}.${flipped(signature, 10)}`],
    ['another spelling of the same signature', `${prefix}.${payload}.${respelled}`],
    ['a padded signature', `${prefix}.${payload}.${signature}=`],
    ['whitespace in the signature', `${prefix}.${payload}.${signature.slice(0, 20)} ${signature.slice(20)}`],
    ['no signature', `${prefix}.${payload}.`],
    ['two segments', `${prefix}.${payload}`],
    ['four segments', `${token}.${signature}`],
    ['nothing', ''],
    ['a Firebase ID token', fakeIdToken()],
  ] as const) {
    await assert.rejects(verifyAgentToken(changed, env, NOW), refused, why);
  }
});

test('a signed payload with a scope the server does not know, or a field of the wrong type, is refused', async () => {
  for (const [why, payload] of [
    ['an unknown scope', claims({ scopes: ['account:write'] })],
    ['an unknown scope beside a known one', claims({ scopes: ['account:read', 'lists:delete'] })],
    ['a scope listed twice', claims({ scopes: ['account:read', 'account:read'] })],
    ['no scopes', claims({ scopes: [] })],
    ['scopes as text', claims({ scopes: 'account:read' })],
    ['no account', claims({ uid: '' })],
    ['a numeric account', claims({ uid: 42 })],
    ['an account longer than a Firebase user ID', claims({ uid: 'u'.repeat(129) })],
    ['an expiry as text', claims({ exp: String(NOW / 1000 + 600) })],
    ['no expiry', claims({ exp: undefined })],
    ['no issue time', claims({ iat: undefined })],
    ['an expiry that has passed', claims({ exp: NOW / 1000 })],
    ['a payload that is not an object', 'null'],
    ['a payload that is not JSON', '{"uid":'],
  ] as const) {
    await assert.rejects(verifyAgentToken(await signed(payload), env, NOW), refused, why);
  }
});

test('a token longer than 2,048 characters is refused', async () => {
  const long = await signed(claims({ padding: 'x'.repeat(2_000) }));
  assert.ok(long.length > 2_048);
  await assert.rejects(verifyAgentToken(long, env, NOW), refused);
});

test('only a known scope can be minted', async () => {
  const mint = (scopes: unknown) => mintAgentToken(env, 'alice-uid', scopes as Parameters<typeof mintAgentToken>[2], NOW);
  for (const scopes of [['account:write'], ['account:read', 'lists:delete'], [], ['account:read', 'account:read']]) {
    await assert.rejects(mint(scopes), { name: 'AgentTokenError', code: 'INVALID_SCOPE', status: 400 }, JSON.stringify(scopes));
  }
  const { token } = await mint(['lists:write', 'feeds:write']);
  assert.deepEqual(await verifyAgentToken(token, env, NOW), { uid: 'alice-uid', scopes: ['lists:write', 'feeds:write'] });
  // Nor a token for no account, which `verifyAgentToken` would refuse.
  for (const uid of ['', 'u'.repeat(129)]) {
    await assert.rejects(mintAgentToken(env, uid, ['account:read'], NOW), refused, `${uid.length} characters`);
  }
});

test('without a secret of at least 32 characters nothing is minted or verified', async () => {
  const { token } = await mintAgentToken(env, 'alice-uid', ['account:read'], NOW);
  for (const secret of [undefined, '', 'short-secret', 'x'.repeat(31)]) {
    const unconfigured: WorkerEnv = { MCP_AGENT_TOKEN_SECRET: secret };
    await assert.rejects(mintAgentToken(unconfigured, 'alice-uid', ['account:read'], NOW), notConfigured, String(secret));
    await assert.rejects(verifyAgentToken(token, unconfigured, NOW), notConfigured, String(secret));
  }
});

// ─── POST /mcp/token ───

const PROJECT_ID = 'papertok-test';
const APP = 'https://papertok.app';
const TOKEN_URL = 'https://papertok-report-api.example/mcp/token';

let pinnedClock: ReturnType<typeof mock.method> | undefined;
beforeEach(() => { pinnedClock = mock.method(Date, 'now', () => NOW); });
afterEach(() => { pinnedClock?.mock.restore(); });

const routeEnv = (extra: Partial<WorkerEnv> = {}): WorkerEnv => ({
  MCP_AGENT_TOKEN_SECRET: SECRET,
  PDF_RATE_LIMIT_SECRET: 'test-only-pdf-rate-limit-key-32-bytes',
  FIREBASE_WEB_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
  ...extra,
});

// Identity Toolkit, answering for the account each ID token was issued to.
async function withIdentities<T>(accounts: Record<string, string>, run: (lookups: () => number) => Promise<T>) {
  const originalFetch = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) throw new Error(`unexpected upstream ${url}`);
    lookups += 1;
    const uid = accounts[(JSON.parse(String(init?.body)) as { idToken: string }).idToken];
    return uid
      ? Response.json({ users: [{ localId: uid, email: `${uid}@example.org`, emailVerified: true }] })
      : Response.json({ error: { message: 'INVALID_ID_TOKEN' } }, { status: 400 });
  };
  try {
    return await run(() => lookups);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The clock is pinned, so each ID token's expiry is stated against it.
const idToken = (sub: string) => fakeIdToken({ aud: PROJECT_ID, sub, exp: NOW / 1000 + 3600 });
const ALICE = idToken('alice-uid');
const BOB = idToken('bob-uid');
const ACCOUNTS = { [ALICE]: 'alice-uid', [BOB]: 'bob-uid' };

function tokenRequest({ idToken = ALICE, origin = APP, method = 'POST', body, ip = '192.0.2.7' }: { idToken?: string | null; origin?: string | null; method?: string; body?: string; ip?: string | null } = {}) {
  return new Request(TOKEN_URL, {
    method,
    headers: {
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
      ...(origin ? { origin } : {}),
      ...(idToken ? { authorization: `Bearer ${idToken}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

async function ask(workerEnv: WorkerEnv, options?: Parameters<typeof tokenRequest>[0]) {
  const response = await reportApi.fetch(tokenRequest(options), workerEnv);
  const text = await response.text();
  return { response, answer: (text ? JSON.parse(text) : null) as { token?: string; expiresAt?: string; scopes?: string[]; code?: string } | null };
}

test('a signed-in reader is given a token for their own account', async () => {
  await withIdentities(ACCOUNTS, async () => {
    const workerEnv = routeEnv();
    const { response, answer } = await ask(workerEnv);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), APP);
    assert.deepEqual(answer?.scopes, ['account:read']);
    assert.equal(answer?.expiresAt, new Date(NOW + THIRTY_MINUTES).toISOString());
    assert.deepEqual(await verifyAgentToken(String(answer?.token), workerEnv), { uid: 'alice-uid', scopes: ['account:read'] });

    const named = await ask(workerEnv, { idToken: BOB, body: JSON.stringify({ scopes: ['account:read'] }) });
    assert.equal(named.response.status, 200);
    assert.deepEqual(await verifyAgentToken(String(named.answer?.token), workerEnv), { uid: 'bob-uid', scopes: ['account:read'] });

    const empty = await ask(workerEnv, { body: '{}' });
    assert.deepEqual(empty.answer?.scopes, ['account:read']);
  });
});

test('a scope that writes is given only to a request that names it', async () => {
  await withIdentities(ACCOUNTS, async () => {
    const workerEnv = routeEnv();
    for (const scopes of [['lists:write'], ['feeds:write', 'account:read'], ['account:read', 'lists:write', 'feeds:write']]) {
      const { response, answer } = await ask(workerEnv, { body: JSON.stringify({ scopes }) });
      assert.equal(response.status, 200, scopes.join(' '));
      assert.deepEqual(answer?.scopes, scopes);
      assert.deepEqual(await verifyAgentToken(String(answer?.token), workerEnv), { uid: 'alice-uid', scopes });
    }
    // No body, an empty object and a body without scopes ask for nothing by name.
    for (const body of [undefined, '{}', JSON.stringify({ note: 'all of them, please' })]) {
      const { answer } = await ask(workerEnv, { body });
      assert.deepEqual((await verifyAgentToken(String(answer?.token), workerEnv)).scopes, ['account:read'], String(body));
    }
  });
});

test('the packaged macOS app is answered as the website is', async () => {
  await withIdentities(ACCOUNTS, async () => {
    const workerEnv = routeEnv({ ALLOWED_ORIGINS: 'tauri://localhost' });
    const preflight = await reportApi.fetch(new Request(TOKEN_URL, {
      method: 'OPTIONS',
      headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    }), workerEnv);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'tauri://localhost');
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/);
    const { response } = await ask(workerEnv, { origin: 'tauri://localhost' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'tauri://localhost');
  });
});

test('a request that is not signed in is given no token', async () => {
  await withIdentities(ACCOUNTS, async lookups => {
    const workerEnv = routeEnv();
    const anonymous = await ask(workerEnv, { idToken: null });
    assert.deepEqual([anonymous.response.status, anonymous.answer], [401, { code: 'AUTH_REQUIRED' }]);
    assert.equal(lookups(), 0);
    // Well formed, but Identity Toolkit does not know it.
    const unknown = await ask(workerEnv, { idToken: idToken('nobody') });
    assert.equal(lookups(), 1);
    assert.deepEqual([unknown.response.status, unknown.answer], [401, { code: 'AUTH_REQUIRED' }]);
    // An agent token is not a sign-in: it cannot mint its successor.
    const { token } = await mintAgentToken(workerEnv, 'alice-uid', ['account:read']);
    const renewed = await ask(workerEnv, { idToken: token });
    assert.deepEqual([renewed.response.status, renewed.answer], [401, { code: 'AUTH_REQUIRED' }]);
    assert.equal(renewed.response.headers.get('cache-control'), 'no-store');
  });
});

test('an unknown scope or an unreadable body is refused and spends none of the allowance', async () => {
  await withIdentities(ACCOUNTS, async () => {
    const ledger = inMemoryQuotaLedger();
    const workerEnv = routeEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
    for (const [body, code, status] of [
      [JSON.stringify({ scopes: ['account:write'] }), 'INVALID_SCOPE', 400],
      [JSON.stringify({ scopes: ['account:read', 'lists:delete'] }), 'INVALID_SCOPE', 400],
      [JSON.stringify({ scopes: ['lists:write', 'lists:write'] }), 'INVALID_SCOPE', 400],
      [JSON.stringify({ scopes: [] }), 'INVALID_SCOPE', 400],
      [JSON.stringify({ scopes: 'account:read' }), 'INVALID_SCOPE', 400],
      ['["account:read"]', 'INVALID_BODY', 400],
      ['{"scopes":', 'INVALID_BODY', 400],
      ['null', 'INVALID_BODY', 400],
      [JSON.stringify({ scopes: ['account:read'], note: 'x'.repeat(2_000) }), 'PAYLOAD_TOO_LARGE', 413],
    ] as const) {
      const { response, answer } = await ask(workerEnv, { body });
      assert.deepEqual([response.status, answer], [status, { code }], body.slice(0, 60));
    }
    assert.deepEqual(ledger.calls, []);
  });
});

test('one account is given twenty tokens a minute, whatever another account asks for', async () => {
  await withIdentities(ACCOUNTS, async () => {
    const workerEnv = routeEnv();
    for (let minted = 0; minted < 20; minted += 1) {
      const { response } = await ask(workerEnv);
      assert.equal(response.status, 200, `token ${minted + 1}`);
    }
    const { response, answer } = await ask(workerEnv);
    assert.deepEqual([response.status, answer], [429, { code: 'AGENT_TOKEN_RATE_LIMITED' }]);
    // 40 seconds are left of the pinned minute.
    assert.equal(response.headers.get('retry-after'), '40');
    assert.match(response.headers.get('access-control-expose-headers') || '', /retry-after/);
    assert.equal((await ask(workerEnv, { idToken: BOB })).response.status, 200);
    // The next minute is a new allowance.
    pinnedClock?.mock.mockImplementation(() => NOW + 60_000);
    assert.equal((await ask(workerEnv)).response.status, 200);
  });
});

test('an address past sixty requests a minute is refused before its sign-in is looked up', async () => {
  await withIdentities(ACCOUNTS, async lookups => {
    const workerEnv = routeEnv();
    // Sixty requests from one address: twenty tokens each for two accounts, then twenty with an ID token nobody holds.
    const asked = [...Array<string>(20).fill(ALICE), ...Array<string>(20).fill(BOB), ...Array<string>(20).fill(idToken('nobody'))];
    for (const [index, token] of asked.entries()) {
      assert.equal((await ask(workerEnv, { idToken: token })).response.status, index < 40 ? 200 : 401, `request ${index + 1}`);
    }
    assert.equal(lookups(), 60);
    for (const token of [ALICE, BOB, idToken('nobody')]) {
      const { response, answer } = await ask(workerEnv, { idToken: token });
      assert.deepEqual([response.status, answer], [429, { code: 'AGENT_TOKEN_RATE_LIMITED' }]);
      assert.equal(response.headers.get('retry-after'), '40');
    }
    assert.equal(lookups(), 60, 'a refused address asks Identity Toolkit nothing');
    // Another address is counted apart, and so is the next minute.
    const carol = idToken('carol-uid');
    await withIdentities({ [carol]: 'carol-uid' }, async () => {
      assert.equal((await ask(workerEnv, { idToken: carol, ip: '198.51.100.9' })).response.status, 200);
      pinnedClock?.mock.mockImplementation(() => NOW + 60_000);
      assert.equal((await ask(workerEnv, { idToken: carol })).response.status, 200);
    });
    // Without an address nothing can be counted, so nothing is minted.
    const unaddressed = await ask(workerEnv, { ip: null });
    assert.deepEqual([unaddressed.response.status, unaddressed.answer], [503, { code: 'AGENT_TOKEN_QUOTA_NOT_CONFIGURED' }]);
  });
});

test('a method other than POST is refused', async () => {
  await withIdentities(ACCOUNTS, async lookups => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const { response, answer } = await ask(routeEnv(), { method });
      assert.deepEqual([response.status, answer], [405, { code: 'METHOD_NOT_ALLOWED' }], method);
      assert.equal(response.headers.get('allow'), 'POST');
    }
    assert.equal(lookups(), 0);
  });
});

test('an origin outside the allowlist, or none, is refused before the sign-in is checked', async () => {
  await withIdentities(ACCOUNTS, async lookups => {
    for (const origin of ['https://evil.example', 'tauri://localhost', null]) {
      const { response, answer } = await ask(routeEnv(), { origin });
      assert.deepEqual([response.status, answer], [403, { code: 'ORIGIN_NOT_ALLOWED' }], String(origin));
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    assert.equal(lookups(), 0);
  });
});

test('a Worker missing its configuration answers 503 and mints nothing', async () => {
  await withIdentities(ACCOUNTS, async lookups => {
    const secret = await ask(routeEnv({ MCP_AGENT_TOKEN_SECRET: 'too-short' }));
    assert.deepEqual([secret.response.status, secret.answer], [503, { code: 'AGENT_TOKEN_NOT_CONFIGURED' }]);
    assert.equal(lookups(), 0, 'Identity Toolkit is not asked for a token that cannot be minted');
    const auth = await ask(routeEnv({ FIREBASE_WEB_API_KEY: undefined }));
    assert.deepEqual([auth.response.status, auth.answer], [503, { code: 'AUTH_NOT_CONFIGURED' }]);
    // Without the ledger or the caller secret the allowance cannot be counted.
    for (const missing of [{ REQUEST_QUOTA_LEDGER: undefined }, { PDF_RATE_LIMIT_SECRET: undefined }]) {
      const { response, answer } = await ask(routeEnv(missing));
      assert.deepEqual([response.status, answer], [503, { code: 'AGENT_TOKEN_QUOTA_NOT_CONFIGURED' }], Object.keys(missing)[0]);
    }
  });
});

test('a ledger that does not answer is an outage to retry', async () => {
  await withIdentities(ACCOUNTS, async () => {
    const ledger: TestNamespace = {
      idFromName: (name: string): unknown => name,
      get: (): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response('unavailable', { status: 500 }) }),
    };
    const { response, answer } = await ask(routeEnv({ REQUEST_QUOTA_LEDGER: ledger as WorkerEnv['REQUEST_QUOTA_LEDGER'] }));
    assert.deepEqual([response.status, answer], [503, { code: 'QUOTA_LEDGER_UNAVAILABLE' }]);
    assert.equal(response.headers.get('retry-after'), '40');
  });
});
