import assert from 'node:assert/strict';
import test from 'node:test';
import { handleConferenceRequest } from './conference-routes.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { testD1 } from './test-support/sqlite-d1.ts';

const origin = 'https://api.papertok.app';

test('the public reader validates its request before requiring storage or quota', async () => {
  for (const [path, method, code, status] of [
    ['/conferences/neurips-2026/papers', 'POST', 'METHOD_NOT_ALLOWED', 405],
    ['/conferences/nonexistent/papers', 'GET', 'CONFERENCE_NOT_FOUND', 404],
    ['/conferences/neurips-2026/papers?after=garbage', 'GET', 'INVALID_CURSOR', 400],
    ['/conferences/neurips-2026/papers', 'GET', 'CONFERENCE_LISTS_UNAVAILABLE', 503],
    ['/conferences/status', 'GET', 'CONFERENCE_LISTS_UNAVAILABLE', 503],
  ] as const) {
    const response = await handleConferenceRequest(new Request(origin + path, { method }), {}, '', {});
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { code });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('a signed-out reader can page through only the requested edition', async context => {
  const { binding, db } = testD1();
  context.after(() => db.close());
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const cache = new Map<string, Response>();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: {
      match: async (key: Request) => cache.get(key.url)?.clone(),
      put: async (key: Request, response: Response) => { cache.set(key.url, response); },
    } },
  });
  context.after(() => {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else Reflect.deleteProperty(globalThis, 'caches');
  });
  db.exec("INSERT INTO conference_editions (edition_id, checked_at) VALUES ('neurips-2026', 123)");
  const insert = db.prepare(`
    INSERT INTO conference_papers
      (edition_id, paper_id, forum_id, venue_id, track, sort_key, paper, seen_generation, visible)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
  `);
  for (let index = 0; index < 16; index++) {
    const id = 'openreview:paper-' + index;
    insert.run('neurips-2026', id, id, 'NeurIPS.cc/2026/Conference', 'oral',
      '0' + index.toString(16).padStart(64, '0'), JSON.stringify({ id, title: 'Paper ' + index }));
  }
  insert.run('iclr-2026', 'openreview:other', 'other', 'ICLR.cc/2026/Conference', 'oral',
    '0'.repeat(65), JSON.stringify({ id: 'openreview:other' }));

  const env = {
    CONFERENCE_PAPERS_ENABLED: '1', PAPER_STORE: binding,
    REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, PDF_RATE_LIMIT_SECRET: 'x'.repeat(32),
  };
  const request = async (path: string) => {
    const response = await handleConferenceRequest(new Request(origin + path, {
      headers: { 'cf-connecting-ip': '203.0.113.20' },
    }), env, '', {});
    assert.equal(response.status, 200);
    return response;
  };
  const status = await request('/conferences/status');
  assert.deepEqual(await status.json(), { editions: [{ id: 'neurips-2026', listed: 16, updatedAt: 123, staleSince: null }] });
  const path = '/conferences/neurips-2026/papers';
  const first = await (await request(path)).json<{ papers: { paper: { id: string } }[]; next: string }>();
  assert.deepEqual(first.papers.map(row => row.paper.id), Array.from({ length: 15 }, (_, index) => 'openreview:paper-' + index));
  assert.equal(first.next, '0'.repeat(64) + 'e');
  const second = await request(path + '?after=' + first.next);
  assert.deepEqual(await second.json(), {
    papers: [{ paper: { id: 'openreview:paper-15', title: 'Paper 15' }, track: 'oral' }],
    next: null,
  });
});
