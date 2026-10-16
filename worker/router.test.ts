import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './index.ts';

const ORIGIN = 'http://localhost:5173';
const request = (path, method = 'GET', origin = ORIGIN) => new Request(`https://api.papertok.test${path}`, {
  method,
  headers: origin ? { origin } : {},
});

for (const path of ['/missing', '/share/paper/missing', '/account/delete', '/related', '/notifications/unsubscribe']) {
  test(`OPTIONS ${path} runs before route access checks`, async () => {
    const response = await worker.fetch(request(path, 'OPTIONS'), {});
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, PUT, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-headers'), 'authorization, content-type');
    assert.equal(response.headers.get('access-control-max-age'), '86400');
  });
}

test('a disallowed preflight still returns 204 without granting CORS', async () => {
  const response = await worker.fetch(request('/account/delete', 'OPTIONS', 'https://other.example'), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('unknown paths preserve GET 404 and other-method 405 with allowed-origin CORS', async () => {
  for (const method of ['GET', 'POST', 'HEAD']) {
    const response = await worker.fetch(request('/missing', method), {});
    assert.equal(response.status, method === 'GET' ? 404 : 405);
    assert.deepEqual(await response.json(), { error: method === 'GET' ? 'Not found' : 'Method not allowed' });
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('the public configuration health route does not become origin-gated', async () => {
  const response = await worker.fetch(request('/health', 'GET', 'https://other.example'), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

for (const method of ['GET', 'POST']) {
  test(`unsubscribe ${method} bypasses the notification Origin gate and stays HTML`, async () => {
    const response = await worker.fetch(request('/notifications/unsubscribe', method, 'https://other.example'), {
      NOTIFICATION_STORE: { get: async () => null },
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(await response.text(), /<html lang="en">/);
  });
}

test('unsubscribe PUT still goes through the notification Origin gate', async () => {
  const response = await worker.fetch(request('/notifications/unsubscribe', 'PUT', 'https://other.example'), {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { code: 'EMAIL_ORIGIN_NOT_ALLOWED' });
});

for (const path of ['/related', '/citation-graph', '/sources/core', '/sources/physics', '/sources/scopus']) {
  test(`${path} requires identity before validating a query or reading the cache`, async () => {
    const response = await worker.fetch(request(path), { FIREBASE_WEB_API_KEY: 'test-key' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: 'AUTH_REQUIRED' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  });
}

test('the scheduled entry point passes the event time and keeps the job alive with waitUntil', async () => {
  const jobs = [];
  const saved = [];
  const scheduledTime = Date.parse('2026-10-13T07:20:00Z');
  await worker.scheduled({ scheduledTime }, {
    NOTIFICATION_STORE: { put: async (key, value) => saved.push({ key, value: JSON.parse(value) }) },
  }, { waitUntil: job => jobs.push(job) });
  assert.equal(jobs.length, 1);
  const [summary] = await Promise.all(jobs);
  assert.equal(summary.scheduledAt, '2026-10-13T07:20:00.000Z');
  assert.equal(summary.disabled, true);
  assert.equal(summary.sent, 0);
  assert.ok(saved.some(({ value }) => value.scheduledAt === '2026-10-13T07:20:00.000Z'));
});
