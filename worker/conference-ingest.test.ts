import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Paper } from '../src/models/paper.ts';
import { runConferenceIngest } from './conference-ingest.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { testD1 } from './test-support/sqlite-d1.ts';

const venue = 'NeurIPS.cc/2026/Conference';
const day = 86_400_000;
let account = 0;

function submission(forum: string, venueId = venue, content: Record<string, { value: unknown; readers?: string[] }> = {}) {
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

test('search staging skips archives and private fields, and bounds public metadata', async context => {
  const state = fixture(context);
  const notes = [
    { ...submission('archived'), domain: 'openreview.net/archive/collection' },
    'not a note',
    { ...submission('invalidContent'), content: 'not content' },
    submission('privateVenue', venue, { venueid: { value: venue, readers: ['chairs'] } }),
    submission('privateAuthors', venue, { authors: { value: ['Private Author'], readers: ['chairs'] } }),
    submission('bounded', venue, {
      title: { value: 'T'.repeat(600) }, venue: { value: 'V'.repeat(300) },
      authors: { value: Array.from({ length: 80 }, () => 'A'.repeat(260)) },
      keywords: { value: Array.from({ length: 40 }, (_, index) => `${index}${'K'.repeat(140)}`) },
      license: { value: 'L'.repeat(200) }, doi: { value: '10.1000/' + 'd'.repeat(300) },
      pdf: { value: 'https://arxiv.org.example.com/paper.pdf' },
    }),
    submission('safePdf', venue, { pdf: { value: 'https://openreview.net/pdf?id=safePdf' } }),
  ];
  context.mock.method(globalThis, 'fetch', async () => Response.json({ notes, count: notes.length }));
  await state.run();
  assert.deepEqual(state.papers().map(row => row.forum_id), ['bounded', 'privateAuthors', 'safePdf']);
  const [bounded, privateAuthors, safePdf] = state.papers().map(row => JSON.parse(String(row.paper)) as Paper);
  assert.equal(bounded.title.length, 512);
  assert.equal(bounded.conference?.length, 200);
  assert.equal(bounded.license, undefined);
  assert.equal(bounded.doi, undefined);
  assert.equal(bounded.pdfUrl, undefined);
  assert.equal(bounded.keywords?.length, 32);
  assert.equal(bounded.keywords?.[0].length, 120);
  assert.equal(bounded.concepts?.length, 32);
  assert.equal(bounded.concepts?.[0].display_name?.length, 120);
  assert.ok(bounded.authors.length > 0 && bounded.authors.length <= 64);
  assert.equal(typeof bounded.authors[0] === 'string' ? bounded.authors[0].length : bounded.authors[0].name.length, 200);
  assert.deepEqual(privateAuthors.authors, []);
  assert.equal(safePdf.pdfUrl, 'https://openreview.net/pdf?id=safePdf');
});

test('an oversized search body cannot complete a harvest', async context => {
  const state = fixture(context);
  context.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  await state.run();
  assert.deepEqual(state.papers(), []);
  assert.equal(state.db.prepare("SELECT failures FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.failures, 1);
});

for (const kind of ['short', 'missing count', 'negative count', 'count smaller than notes', 'duplicate forums below count']) {
  test('first harvest stays unpublished on ' + kind, async context => {
    const state = fixture(context);
    const accepted = submission('first');
    const payload = kind === 'short' ? { notes: [accepted], count: 5 }
      : kind === 'missing count' ? { notes: [accepted] }
      : kind === 'negative count' ? { notes: [accepted], count: -1 }
      : kind === 'count smaller than notes' ? { notes: [accepted], count: 0 }
      : { notes: [accepted, accepted], count: 2 };
    context.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await state.run();
    assert.deepEqual(state.papers(), []);
    assert.equal(state.db.prepare("SELECT checked_at FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.checked_at, null);
  });
}

for (const kind of ['withdrawn', 'rejected', 'deleted', 'restricted', 'not found', 'empty', 'partial', 'unknown', 'unknown visibility', 'malformed readers', 'empty readers', 'future deletion', 'error']) {
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
      : kind === 'empty readers' ? Response.json({ notes: [{ ...withdrawn, readers: [] }] })
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

test('changed venues in search preserve the edition until exact lookups confirm a change', async context => {
  const state = fixture(context, { credentials: true });
  const forums = ['first', 'second', 'third'];
  let searchVenue = venue;
  const lookups: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input);
    if (url.pathname === '/login') return Response.json({ token: 'mock-session' });
    if (url.pathname === '/notes') {
      lookups.push(url.searchParams.get('id') ?? '');
      return Response.json({ notes: [], count: 0 });
    }
    return Response.json({ notes: forums.map(forum => submission(forum, searchVenue)), count: forums.length });
  });
  const edition = state.db.prepare("SELECT listed_count FROM conference_editions WHERE edition_id = 'neurips-2026'");
  const blockCount = state.db.prepare('SELECT COUNT(*) AS count FROM conference_forum_block');
  await state.run();
  assert.deepEqual(state.papers().map(paper => paper.visible), [1, 1, 1]);
  searchVenue = venue.toLowerCase();
  state.advance(60_000);
  state.refresh();
  await state.run();
  assert.deepEqual(lookups, forums);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM conference_papers WHERE missing_from_search = 1').get()?.count, 3);
  assert.equal(blockCount.get()?.count, 0);
  assert.equal(edition.get()?.listed_count, 3);

  searchVenue = venue;
  state.advance(8 * day);
  state.refresh();
  await state.run();
  assert.deepEqual(state.papers().map(paper => paper.visible), [1, 1, 1]);
  assert.equal(blockCount.get()?.count, 0);
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
  assert.deepEqual(lookups, ['second', 'first']);
  assert.deepEqual(state.papers().map(paper => paper.visible), [1, 1]);
});

for (const healthy of [true, false]) {
  test(`absent forums ${healthy ? 'hide on three distinct healthy days and return when public' : 'stay listed without a healthy exact control'}`, async context => {
    const state = fixture(context, { credentials: true });
    const control = submission('control');
    const removed = submission('removed');
    let present = true;
    let empty = false;
    context.mock.method(globalThis, 'fetch', async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/login') return Response.json({ token: 'mock-session' });
      if (url.pathname === '/notes') {
        assert.equal(url.searchParams.get('trash'), 'true');
        if (url.searchParams.get('id') === 'control' && healthy) return Response.json({ notes: [control], count: 1 });
        return empty ? Response.json({ notes: [], count: 0 }) : new Response(null, { status: 404 });
      }
      const notes = present ? [control, removed] : [control];
      return Response.json({ notes, count: notes.length });
    });
    await state.run();
    present = false;
    const removedState = state.db.prepare("SELECT visible, absent_days FROM conference_papers WHERE forum_id = 'removed'");
    const edition = state.db.prepare("SELECT listed_count, revision FROM conference_editions WHERE edition_id = 'neurips-2026'");

    state.advance(60_000);
    state.refresh();
    await state.run();
    assert.deepEqual({ ...removedState.get() }, { visible: 1, absent_days: healthy ? 1 : 0 });

    state.advance(60_000);
    state.refresh();
    await state.run();
    assert.deepEqual({ ...removedState.get() }, { visible: 1, absent_days: healthy ? 1 : 0 });

    empty = true;
    state.advance();
    await state.run();
    assert.deepEqual({ ...removedState.get() }, { visible: 1, absent_days: healthy ? 2 : 0 });
    state.advance();
    await state.run();
    assert.deepEqual({ ...removedState.get() }, { visible: healthy ? 0 : 1, absent_days: healthy ? 3 : 0 });
    assert.equal(edition.get()?.listed_count, healthy ? 1 : 2);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM conference_forum_block').get()?.count, 0);

    present = true;
    state.advance(60_000);
    state.refresh();
    await state.run();
    assert.deepEqual({ ...removedState.get() }, { visible: 1, absent_days: 0 });
    assert.equal(edition.get()?.listed_count, 2);
  });
}

for (const [signal, fields] of Object.entries({
  'empty readers': { readers: [] },
  'restricted readers': { readers: ['chairs'] },
  'deletion date': { ddate: Date.UTC(2026, 10, 22) },
})) {
  test(`search with ${signal} defers to exact lookups and preserves the published edition`, async context => {
    const state = fixture(context, { credentials: true });
    const accepted = ['first', 'second', 'third'].map(forum => submission(forum));
    let degradedSearch = false;
    const lookups: string[] = [];
    context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
      const url = new URL(input);
      if (url.pathname === '/login') return Response.json({ token: 'mock-session' });
      if (url.pathname === '/notes') {
        lookups.push(url.searchParams.get('id') ?? '');
        return Response.json({ notes: [], count: 0 });
      }
      const notes = degradedSearch ? accepted.map(note => ({ ...note, ...fields })) : accepted;
      return Response.json({ notes, count: notes.length });
    });

    await state.run();
    assert.deepEqual(state.papers().map(paper => paper.visible), [1, 1, 1]);
    degradedSearch = true;
    state.advance(60_000);
    state.refresh();
    await state.run();

    assert.deepEqual(state.papers().map(paper => paper.visible), [1, 1, 1]);
    assert.deepEqual(lookups, ['first', 'second', 'third']);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM conference_papers WHERE missing_from_search = 1').get()?.count, 3);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM conference_forum_block').get()?.count, 0);
    assert.equal(state.db.prepare("SELECT listed_count FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.listed_count, 3);
  });
}

test('a restricted search hit does not prevent a small edition from adding a new paper', async context => {
  const state = fixture(context);
  let notes = Array.from({ length: 40 }, (_, index) => submission(`paper-${index}`));
  context.mock.method(globalThis, 'fetch', async () => Response.json({ notes, count: notes.length }));
  await state.run();
  assert.equal(state.papers().length, 40);

  notes = [{ ...notes[0], readers: ['chairs'] }, ...notes.slice(1), submission('new')];
  state.advance(60_000);
  state.refresh();
  await state.run();

  assert.equal(state.papers().find(paper => paper.forum_id === 'new')?.visible, 1);
  assert.equal(state.papers().find(paper => paper.forum_id === 'paper-0')?.visible, 1);
  const edition = state.db.prepare("SELECT checked_at, source_count, listed_count FROM conference_editions WHERE edition_id = 'neurips-2026'");
  assert.deepEqual({ ...edition.get() }, { checked_at: Date.now(), source_count: 41, listed_count: 41 });
});

test('the drop check counts eligible results across every page of a search', async context => {
  const state = fixture(context);
  const notes = Array.from({ length: 100 }, (_, index) => submission(`paper-${index}`));
  context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input);
    if (url.searchParams.get('term') === 'a') return Response.json({ notes: notes.slice(0, 1), count: 1 });
    const offset = url.searchParams.get('offset');
    return Response.json({ notes: offset === '0' ? notes : notes.slice(0, 4), count: 104 });
  });
  await state.run();
  assert.deepEqual(state.papers(), []);
  const edition = state.db.prepare("SELECT checked_at, source_count FROM conference_editions WHERE edition_id = 'neurips-2026'");
  assert.deepEqual({ ...edition.get() }, { checked_at: null, source_count: 104 });
});

test('a lower count on the next page cannot complete a search pass', async context => {
  const state = fixture(context);
  const notes = Array.from({ length: 101 }, (_, index) => submission(`paper-${index}`));
  context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input);
    if (url.searchParams.get('term') === 'a') return Response.json({ notes: notes.slice(0, 1), count: 1 });
    const firstPage = url.searchParams.get('offset') === '0';
    return Response.json(firstPage ? { notes: notes.slice(0, 100), count: 200 } : { notes: notes.slice(100), count: 101 });
  });
  await state.run();
  assert.deepEqual(state.papers(), []);
  const edition = state.db.prepare("SELECT checked_at, source_count, failures FROM conference_editions WHERE edition_id = 'neurips-2026'");
  assert.deepEqual({ ...edition.get() }, { checked_at: null, source_count: null, failures: 1 });
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
  assert.equal(state.db.prepare("SELECT retry_after FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.retry_after, Date.now() + 5 * 60_000);
  state.advance(5 * 60_000);
  await state.run();
  assert.equal(checks, 2);
});

test('the documented manual block survives the next accepted harvest', async context => {
  const state = fixture(context);
  const notes = [submission('first'), submission('second')];
  context.mock.method(globalThis, 'fetch', async () => Response.json({ notes, count: notes.length }));
  await state.run();
  const edition = state.db.prepare("SELECT revision, listed_count, checked_at, stale_since FROM conference_editions WHERE edition_id = 'neurips-2026'");
  const before = edition.get();
  assert.ok(before && typeof before.revision === 'number');
  assert.equal(before.listed_count, 2);

  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const section = readme.split('### Manually block a forum')[1]?.split('\n### ')[0] ?? '';
  const [takedown, verify] = [...section.matchAll(/--command "([^"]+)"/g)].map(([, sql]) => sql);
  assert.ok(takedown && verify);
  const forForum = (sql: string, editionId: string, forumId: string) =>
    sql.replaceAll('$edition_id', editionId).replaceAll('$forum_id', forumId);

  for (const [editionId, forumId] of [['neurips-2026', 'typo'], ['iclr-2026', 'first']]) {
    state.db.exec(forForum(takedown, editionId, forumId));
    assert.equal(state.db.prepare(forForum(verify, editionId, forumId)).get(), undefined);
  }
  assert.equal(edition.get()?.revision, before.revision);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM conference_forum_block').get()?.count, 0);

  state.db.exec(forForum(takedown, 'neurips-2026', 'first'));
  assert.deepEqual({ ...state.db.prepare(forForum(verify, 'neurips-2026', 'first')).get() },
    { edition_id: 'neurips-2026', forum_id: 'first', venue_id: 'manual', visible: 0, listed_count: 1 });
  assert.deepEqual(state.papers().map(paper => paper.visible), [0, 1]);
  assert.equal(edition.get()?.revision, before.revision + 1);
  assert.equal(edition.get()?.listed_count, 1);

  state.advance(60_000);
  state.refresh();
  await state.run();
  assert.deepEqual(state.papers().map(paper => paper.visible), [0, 1]);
  assert.deepEqual({ ...edition.get() }, { revision: before.revision + 2, listed_count: 1, checked_at: Date.now(), stale_since: null });

  const erasureSection = readme.split('### Erase or restore a blocked forum')[1]?.split('\n### ')[0] ?? '';
  const erasure = erasureSection.match(/--command "([^"]+)"/)?.[1];
  assert.ok(erasure);
  state.db.exec(forForum(erasure, 'neurips-2026', 'first'));
  assert.deepEqual(state.papers().map(paper => paper.forum_id), ['second']);
  state.refresh();
  await state.run();
  assert.deepEqual(state.papers().map(paper => paper.forum_id), ['second']);
  assert.equal(state.db.prepare("SELECT venue_id FROM conference_forum_block WHERE forum_id = 'first'").get()?.venue_id, 'manual');
});

test('a different venue in the first harvest leaves the forum unpublished and unblocked', async context => {
  const state = fixture(context);
  let found = submission('first', venue + '/Withdrawn_Submission');
  context.mock.method(globalThis, 'fetch', async () => Response.json({ notes: [found], count: 1 }));
  await state.run();
  assert.deepEqual(state.papers(), []);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM conference_forum_block').get()?.count, 0);

  found = submission('first');
  state.refresh();
  await state.run();
  assert.equal(state.papers()[0]?.visible, 1);
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
  assert.equal(state.db.prepare("SELECT retry_after FROM conference_editions WHERE edition_id = 'neurips-2026'").get()?.retry_after, Date.now() + 5 * 60_000);
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
    INSERT INTO conference_editions (edition_id, term, offset, failures, expected_count,
      first_term_reported_count, first_term_eligible_count, term_eligible_count)
    VALUES ('neurips-2026', 1, 10000, 2, 10001, 105, 98, 9700);
  `);
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ notes: [], count: 0 }); });
  await state.run();
  const row = state.db.prepare(`SELECT term, offset, expected_count, first_term_reported_count,
    first_term_eligible_count, term_eligible_count, next_check_at FROM conference_editions WHERE edition_id = 'neurips-2026'`).get();
  assert.deepEqual({ ...row }, { term: 0, offset: 0, expected_count: 0, first_term_reported_count: 0,
    first_term_eligible_count: 0, term_eligible_count: 0, next_check_at: Date.parse('2026-11-24T00:00:00Z') });
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
