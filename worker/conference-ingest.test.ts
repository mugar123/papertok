import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { runConferenceIngest } from './conference-ingest.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { testD1 } from './test-support/sqlite-d1.ts';

const venue = 'NeurIPS.cc/2026/Conference';
const day = 86_400_000;
let account = 0;

function submission(forum: string, venueId = venue, content: Record<string, { value: unknown }> = {}) {
  return {
    id: forum, forum, readers: ['everyone'],
    content: { venueid: { value: venueId }, title: { value: 'A conference paper' }, ...content },
  };
}

function fixture(context: TestContext, { credentials = false, otherEditions = false } = {}) {
  const { binding, db } = testD1();
  context.after(() => db.close());
  if (!otherEditions) db.exec(`
    INSERT INTO conference_editions (edition_id, next_check_at) VALUES
      ('iclr-2026', 9999999999999), ('iclr-2027', 9999999999999),
      ('icml-2026', 9999999999999), ('colm-2026', 9999999999999);
  `);
  const quota = inMemoryQuotaLedger();
  let now = Date.parse('2026-11-23T02:30:00Z');
  context.mock.method(Date, 'now', () => now);
  const env = {
    PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: quota.binding, CONFERENCE_PAPERS_ENABLED: '1',
    ...(credentials ? { OPENREVIEW_USERNAME: 'test-user-' + ++account, OPENREVIEW_PASSWORD: 'test-password' } : {}),
  };
  const sleeps: string[] = [];
  type Callback = () => Promise<unknown>;
  const step = {
    do: async (_name: string, config: object | Callback, callback?: Callback) => {
      if (typeof config === 'function') return config();
      assert.deepEqual(config, { retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes' });
      assert.ok(callback);
      return callback();
    },
    sleep: async (_name: string, duration: string) => {
      sleeps.push(duration);
      if (duration === '1 minute') now += 60_000;
    },
  } as unknown as Parameters<typeof runConferenceIngest>[1];
  const papers = () => db.prepare('SELECT forum_id, visible, paper FROM conference_papers ORDER BY forum_id').all();
  return {
    db, sleeps, quota, papers, run: () => runConferenceIngest(env, step), advance: (ms = day) => { now += ms; },
    refresh: () => db.exec("UPDATE conference_editions SET next_check_at = 0 WHERE edition_id = 'neurips-2026'"),
  };
}

test('a complete first harvest publishes distinct forums and strips private author identifiers and unsafe PDF links', async context => {
  const state = fixture(context);
  const rows = [
    submission('first', venue, {
      arxiv_id: { value: '2601.12567' }, pdf: { value: 'javascript:alert(1)' },
      authors: { value: ['A', 'B', 'C', 'private@example.test'] }, authorids: { value: ['a@example.test', '~Example_Author1', 'https://orcid.org/0000-0002-1825-0097'] },
    }),
    submission('second', venue, { arxiv_id: { value: '2601.12567' } }),
  ];
  context.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('count'), 'true');
    assert.equal(url.searchParams.get('venueid'), venue);
    assert.equal(state.papers().length, 0);
    return Response.json({ notes: rows, count: 2 });
  });
  await state.run();
  const papers = state.papers().map(row => JSON.parse(String(row.paper)) as { id: string; pdfUrl?: string; authors: { id?: string }[] });
  assert.deepEqual(papers.map(row => row.id), ['openreview:first', 'openreview:second']);
  assert.deepEqual(papers[0].authors.map(author => author.id), [undefined, '~Example_Author1', '0000-0002-1825-0097']);
  assert.equal(papers[0].pdfUrl, undefined);
  assert.deepEqual(state.sleeps, ['5 seconds', '5 seconds']);
  assert.deepEqual({ ...state.db.prepare("SELECT listed_count, source_count FROM conference_editions WHERE edition_id = 'neurips-2026'").get() },
    { listed_count: 2, source_count: 2 });
});

for (const kind of ['short', 'missing count', 'negative count', 'count smaller than notes', 'filtered below count']) {
  test('first harvest stays unpublished on ' + kind, async context => {
    const state = fixture(context);
    const accepted = submission('first');
    const payload = kind === 'short' ? { notes: [accepted], count: 5 }
      : kind === 'missing count' ? { notes: [accepted] }
      : kind === 'negative count' ? { notes: [accepted], count: -1 }
      : kind === 'count smaller than notes' ? { notes: [accepted], count: 0 }
      : { notes: [accepted, submission('unrelated', 'Example.org/Conference')], count: 2 };
    context.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await state.run();
    assert.deepEqual(state.papers(), []);
    assert.equal(state.db.prepare("SELECT checked_at FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.checked_at, null);
  });
}

for (const kind of ['withdrawn', 'rejected', 'deleted', 'restricted', 'not found', 'empty', 'partial', 'unknown', 'unknown visibility', 'malformed readers', 'future deletion', 'error']) {
  test('forum recheck handles ' + kind + ' evidence', async context => {
    const state = fixture(context, { credentials: true });
    const forum = 'knownForum';
    const accepted = submission(forum);
    const withdrawn = submission(forum, venue + '/Withdrawn_Submission');
    const rejected = submission(forum, venue + '/Rejected_Submission');
    const response = kind === 'withdrawn' ? Response.json({ notes: [withdrawn] })
      : kind === 'rejected' ? Response.json({ notes: [rejected] })
      : kind === 'deleted' ? Response.json({ notes: [{ ...accepted, ddate: Date.now() }] })
      : kind === 'restricted' ? Response.json({ notes: [{ ...accepted, readers: ['chairs'] }] })
      : kind === 'not found' ? new Response(null, { status: 404 })
      : kind === 'error' ? new Response(null, { status: 503 })
      : kind === 'partial' ? Response.json({ notes: [withdrawn], count: 2 })
      : kind === 'unknown' ? Response.json({ notes: [{ id: forum, forum, content: {} }] })
      : kind === 'unknown visibility' ? Response.json({ notes: [{ ...withdrawn, readers: 'chairs' }] })
      : kind === 'malformed readers' ? Response.json({ notes: [{ ...withdrawn, readers: ['everyone', 7] }] })
      : kind === 'future deletion' ? Response.json({ notes: [{ ...accepted, ddate: Date.now() + 2 * day }] })
      : Response.json({ notes: [] });
    let lookups = 0;
    context.mock.method(globalThis, 'fetch', async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/login') return Response.json({ token: 'mock-session' });
      if (url.pathname === '/notes') {
        assert.equal(url.searchParams.get('id'), forum);
        if (kind === 'deleted') assert.equal(url.searchParams.get('trash'), 'true');
        lookups++;
        return response.clone();
      }
      return Response.json({ notes: [accepted], count: 1 });
    });
    await state.run();
    assert.equal(state.papers()[0].visible, 1);
    state.advance();
    state.refresh();
    await state.run();
    assert.equal(lookups, 1);
    const hidden = ['withdrawn', 'rejected', 'deleted', 'restricted'].includes(kind);
    assert.equal(state.papers()[0].visible, hidden ? 0 : 1, 'even after the stale discovery response republishes');
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM conference_forum_block').get()?.count, hidden ? 1 : 0);
    assert.ok(state.quota.calls.filter(key => key.includes('openreview-ingest')).length >= 10);
  });
}

test('a changed venue in discovery hides the forum and later accepted search results cannot resurrect it', async context => {
  const state = fixture(context);
  let found = submission('forum');
  context.mock.method(globalThis, 'fetch', async () => Response.json({ notes: [found], count: 1 }));
  await state.run();
  assert.equal(state.papers()[0].visible, 1);
  found = submission('forum', 'Other.cc/2026/Conference');
  state.refresh();
  await state.run();
  assert.equal(state.papers()[0].visible, 0);
  found = submission('forum');
  state.refresh();
  await state.run();
  assert.equal(state.papers()[0].visible, 0);
  state.db.prepare('DELETE FROM conference_forum_block WHERE edition_id = ? AND forum_id = ?').run('neurips-2026', 'forum');
  state.refresh();
  await state.run();
  assert.equal(state.papers()[0].visible, 1);
});

test('a completed pass immediately prioritizes a forum missing from that pass', async context => {
  const state = fixture(context, { credentials: true });
  const first = submission('first');
  const second = submission('second');
  let refresh = false;
  const lookups: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input);
    if (url.pathname === '/login') return Response.json({ token: 'mock-session' });
    if (url.pathname === '/notes') {
      lookups.push(url.searchParams.get('id') ?? '');
      return Response.json({ notes: [] });
    }
    return refresh ? Response.json({ notes: [first], count: 1 }) : Response.json({ notes: [first, second], count: 2 });
  });
  await state.run();
  refresh = true;
  state.advance(60_000);
  state.refresh();
  await state.run();
  assert.deepEqual(lookups, ['second']);
  assert.deepEqual(state.papers().map(paper => paper.visible), [1, 1]);
});

test('the nightly ledger counts a recheck sign-in as the 150th request and refuses the lookup', async context => {
  const state = fixture(context, { credentials: true });
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    calls++;
    return new URL(input).pathname === '/login'
      ? Response.json({ token: 'mock-session' }) : Response.json({ notes: [submission('first')], count: 1 });
  });
  await state.run();
  state.advance();
  const now = Date.now();
  for (let call = 0; call < 149; call++) {
    const quota = await reserveRequestQuota(state.quota.binding, {
      periodKey: 'openreview-ingest:' + new Date(now).toISOString().slice(0, 10),
      subject: 'conference-ingest', subjectLimit: 150, globalLimit: 150, expiresAt: now + day,
    });
    assert.equal(quota.accepted, true);
  }
  await state.run();
  await state.run();
  assert.equal(calls, 3);
  assert.equal(state.papers()[0].visible, 1);
});

test('a recheck 429 keeps the forum and pauses future requests', async context => {
  const state = fixture(context, { credentials: true });
  let checks = 0;
  context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const path = new URL(input).pathname;
    if (path === '/login') return Response.json({ token: 'mock-session' });
    if (path === '/notes') {
      checks++;
      return new Response(null, { status: 429, headers: { 'retry-after': '3600' } });
    }
    return Response.json({ notes: [submission('first')], count: 1 });
  });
  await state.run();
  state.advance();
  await state.run();
  await state.run();
  assert.equal(checks, 1);
  assert.equal(state.papers()[0].visible, 1);
  assert.equal(state.db.prepare("SELECT retry_after FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.retry_after, Date.now() + 3_600_000);
});

test('the documented manual block survives the next accepted harvest', async context => {
  const state = fixture(context);
  context.mock.method(globalThis, 'fetch', async () => Response.json({ notes: [submission('first')], count: 1 }));
  await state.run();
  state.db.exec(`
    BEGIN;
    INSERT INTO conference_forum_block (edition_id, forum_id, venue_id, blocked_at)
    VALUES ('neurips-2026', 'first', 'manual', 1)
    ON CONFLICT (edition_id, forum_id) DO NOTHING;
    UPDATE conference_papers SET visible = 0 WHERE edition_id = 'neurips-2026' AND forum_id = 'first';
    UPDATE conference_editions SET revision = revision + 1,
      listed_count = (SELECT COUNT(*) FROM conference_papers WHERE edition_id = 'neurips-2026' AND visible = 1)
    WHERE edition_id = 'neurips-2026';
    COMMIT;
  `);
  state.refresh();
  await state.run();
  assert.equal(state.papers()[0].visible, 0);
  assert.equal(state.db.prepare("SELECT listed_count FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.listed_count, 0);
});

test('an explicit withdrawal cancels a forum that is staged in the first harvest', async context => {
  const state = fixture(context);
  context.mock.method(globalThis, 'fetch', async (input: URL) => {
    const secondPass = new URL(input).searchParams.get('term') === 'a';
    return Response.json({ notes: [submission('first', secondPass ? venue + '/Withdrawn_Submission' : venue)], count: 1 });
  });
  await state.run();
  assert.deepEqual(state.papers(), []);
  assert.equal(state.db.prepare('SELECT forum_id FROM conference_forum_block').get()?.forum_id, 'first');
});

test('an empty refresh preserves the list, and 429 stops the whole run', async context => {
  const state = fixture(context);
  let reply = () => Response.json({ notes: [submission('first')], count: 1 });
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return reply(); });
  await state.run();
  reply = () => Response.json({ notes: [], count: 0 });
  state.refresh();
  await state.run();
  assert.equal(state.papers()[0].visible, 1);
  reply = () => new Response(null, { status: 429, headers: { 'retry-after': '99999999' } });
  state.refresh();
  await state.run();
  await state.run();
  assert.equal(calls, 5);
  assert.equal(state.db.prepare("SELECT retry_after FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.retry_after, Date.now() + 7 * day);
});

test('an ordinary failure defers one edition and later editions still publish', async context => {
  const state = fixture(context, { otherEditions: true });
  context.mock.method(globalThis, 'fetch', async (input: URL) => {
    const id = new URL(input).searchParams.get('venueid') ?? '';
    if (id.startsWith('colmweb')) return new Response(null, { status: 503 });
    return Response.json({ notes: [submission(id.split('/')[0].replace('.', ''), id)], count: 1 });
  });
  await state.run();
  assert.equal(state.papers().length, 4);
  assert.equal(state.db.prepare("SELECT failures FROM conference_editions WHERE edition_id = 'colm-2026'").get()?.failures, 1);
});

test('the offset cap stops requests and repeated failure resets the unfinished pass', async context => {
  const state = fixture(context);
  state.db.exec(`
    INSERT INTO conference_editions (edition_id, term, offset, failures, expected_count)
    VALUES ('neurips-2026', 1, 10000, 2, 10001);
  `);
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ notes: [], count: 0 }); });
  await state.run();
  const row = state.db.prepare("SELECT term, offset, expected_count, next_check_at FROM conference_editions WHERE edition_id = 'neurips-2026'").get();
  assert.deepEqual({ ...row }, { term: 0, offset: 0, expected_count: 0, next_check_at: Date.parse('2026-11-24T00:00:00Z') });
  assert.equal(calls, 0);
});

test('a full minute pauses the job and leaves nightly discovery available', async context => {
  const state = fixture(context);
  const minute = Math.floor(Date.now() / 60_000);
  for (let call = 0; call < 12; call++) {
    const result = await reserveRequestQuota(state.quota.binding, {
      periodKey: 'openreview-ingest:' + minute, subject: 'conference-ingest',
      subjectLimit: 12, globalLimit: 12, expiresAt: (minute + 2) * 60_000,
    });
    assert.equal(result.accepted, true);
  }
  context.mock.method(globalThis, 'fetch', async () => Response.json({ notes: [submission('first')], count: 1 }));
  await state.run();
  assert.equal(state.sleeps[0], '1 minute');
  assert.equal(state.papers()[0].visible, 1);
});

test('overlapping workflows cannot advance a pass while one holds the lease', async context => {
  const state = fixture(context);
  let finishEntering!: () => void;
  let finishWaiting!: () => void;
  const entered = new Promise<void>(resolve => { finishEntering = resolve; });
  const resume = new Promise<void>(resolve => { finishWaiting = resolve; });
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) {
      finishEntering();
      await resume;
    }
    return Response.json({ notes: [submission('first')], count: 1 });
  });
  const first = state.run();
  await entered;
  await state.run();
  assert.equal(calls, 1);
  assert.deepEqual(state.papers(), []);
  finishWaiting();
  await first;
  assert.equal(calls, 2);
  assert.equal(state.papers()[0].visible, 1);
});
