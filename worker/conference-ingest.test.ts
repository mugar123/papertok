import assert from 'node:assert/strict';
import test from 'node:test';
import { runConferenceIngest } from './conference-ingest.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { testD1 } from './test-support/sqlite-d1.ts';

test('publishes an exact membership after both passes and preserves it during a rate limit', async context => {
  const { binding, db } = testD1();
  context.after(() => db.close());
  db.exec(`
    INSERT INTO conference_editions (edition_id, next_check_at)
    VALUES ('iclr-2026', 9999999999999), ('iclr-2027', 9999999999999),
      ('icml-2026', 9999999999999), ('colm-2026', 9999999999999);
  `);
  const quota = inMemoryQuotaLedger();
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: quota.binding, CONFERENCE_PAPERS_ENABLED: '1' };
  const sleeps: string[] = [];
  type Callback = () => Promise<unknown>;
  const step = {
    do: async (_name: string, config: object | Callback, callback?: Callback) => {
      if (typeof config === 'function') return config();
      assert.deepEqual(config, { retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes' });
      assert.ok(callback);
      return callback();
    },
    sleep: async (_name: string, duration: string) => { sleeps.push(duration); },
  } as unknown as Parameters<typeof runConferenceIngest>[1];

  const terms: string[] = [];
  let venue = 'NeurIPS 2026 Poster';
  let limit = false;
  context.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api2.openreview.net');
    assert.equal(url.searchParams.get('venueid'), 'NeurIPS.cc/2026/Conference');
    terms.push(url.searchParams.get('term') ?? '');
    if (url.searchParams.get('term') === 'a') {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conference_papers').get()?.count, venue.endsWith('Poster') ? 0 : 1);
      if (limit) return new Response(null, { status: 429, headers: { 'retry-after': '172800' } });
    }
    const base = { venue: { value: venue }, title: { value: 'Conference test paper' } };
    return Response.json({ count: 2, notes: [
      { id: 'accepted', forum: 'accepted', content: { ...base, venueid: { value: 'NeurIPS.cc/2026/Conference' } } },
      { id: 'rejected', forum: 'rejected', content: { ...base, venueid: { value: 'NeurIPS.cc/2026/Conference/Rejected' } } },
    ] });
  });
  const track = () => db.prepare("SELECT track FROM conference_papers WHERE paper_id = 'openreview:accepted'").get()?.track;
  await runConferenceIngest(env, step);
  assert.equal(track(), 'poster');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conference_papers').get()?.count, 1);
  assert.deepEqual(terms, ['the', 'a']);
  assert.deepEqual(sleeps, ['5 seconds', '5 seconds']);

  venue = 'NeurIPS 2026 Oral';
  db.exec("UPDATE conference_editions SET next_check_at = 0 WHERE edition_id = 'neurips-2026'");
  await runConferenceIngest(env, step);
  assert.equal(track(), 'oral');

  limit = true;
  venue = 'NeurIPS 2026 Spotlight';
  db.exec("UPDATE conference_editions SET next_check_at = 0 WHERE edition_id = 'neurips-2026'");
  await runConferenceIngest(env, step);
  await runConferenceIngest(env, step);
  assert.deepEqual(terms, ['the', 'a', 'the', 'a', 'the', 'a']);
  assert.equal(db.prepare('SELECT track FROM conference_paper_stage').get()?.track, 'spotlight');
  assert.equal(track(), 'oral');
});
