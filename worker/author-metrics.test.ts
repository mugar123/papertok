import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import { recordAuthorSave, verifiedIdentifiers } from './author-metrics.ts';
import { decodeFields, FirestoreAdminError, type FirestoreWrite } from './firestore-admin.ts';
import { handleRequest } from './router.ts';

const config = 'authorMetricConfig/saves';
const consent = 'users/alice/authorMetricConsent/saves';
const account = 'users/alice';
const week = 'users/alice/authorMetricWeeks/saves-2026-11-23';
const openAlex = 'users/alice/savedPapers/openalex:W42';
const doi = 'users/alice/savedPapers/doi:10.1234%2FExample';
const arxiv = 'users/alice/savedPapers/2611.12345v2';
const monday = Date.parse('2026-11-23T00:00:00Z');
const receipt = '00000000-1111-2222-3333-444444444444';
const alias = (id: string) => `authorMetricAliases/${createHash('sha256').update(id).digest('hex')}`;
const receiptId = (paperId: string) => createHash('sha256').update(paperId).digest('hex');
const receiptPath = (paperId: string) => `users/alice/authorMetricReceipts/${receiptId(paperId)}`;
const event = (paperId: string, now = monday) => ({ paperId, receipt: receiptId(paperId), now });
const saved = (paperId: string, now = monday) => ({ paperId, savedAt: new Date(now) });

test('collection requires an allowed origin, POST and a verified Firebase email', async t => {
  const url = 'https://worker.test/author-metrics/save';
  const origin = 'https://papertok.app';
  const env = { FIREBASE_WEB_API_KEY: 'test-key', FIREBASE_PROJECT_ID: 'papertok-test' };
  assert.equal((await handleRequest(new Request(url, { method: 'POST' }), env)).status, 403);
  assert.equal((await handleRequest(new Request(url, { headers: { origin } }), env)).status, 405);
  assert.equal((await handleRequest(new Request(url, { method: 'POST', headers: { origin } }), env)).status, 401);
  const lookup = t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.match(url, /identitytoolkit\.googleapis\.com\/v1\/accounts:lookup/);
    return Response.json({ users: [{ localId: 'alice', emailVerified: false }] });
  });
  const response = await handleRequest(new Request(url, {
    method: 'POST',
    headers: { origin, authorization: `Bearer ${fakeIdToken({ aud: 'papertok-test' })}` },
    body: JSON.stringify({ paperId: 'openalex:W42', receipt }),
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(lookup.mock.callCount(), 1);
});

function fixture() {
  const documents = new Map<string, object>([
    [config, { enabled: true, launchedAt: new Date('2026-11-20T12:00:00Z') }],
    [account, { onboardingComplete: true }],
    [consent, { enabled: true, changedAt: new Date('2026-11-21T00:00:00Z') }],
    [openAlex, { savedAt: new Date(monday) }],
    [doi, { savedAt: new Date(monday) }],
    [arxiv, { savedAt: new Date(monday) }],
    ...['openalex:W42', 'doi:10.1234/Example', '2611.12345v2'].map(
      (id): [string, object] => [receiptPath(id), saved(id)],
    ),
  ]);
  let nextTransaction = 0;
  const transactions = new Map<string, Map<string, object>>();
  const admin = {
    name: (path: string[]) => path.join('/'),
    async beginTransaction() {
      const id = String(nextTransaction++);
      transactions.set(id, new Map(documents));
      return id;
    },
    async batchGet<T extends object>(paths: string[][], transaction?: string) {
      assert.ok(transaction);
      return paths.map(path => (transactions.get(transaction)?.get(path.join('/')) ?? null) as T | null);
    },
    async commit(writes: FirestoreWrite[], transaction?: string) {
      assert.ok(transaction);
      const snapshot = transactions.get(transaction);
      assert.ok(snapshot);
      for (const write of writes) {
        assert.ok(write.update);
        const { name } = write.update;
        if (documents.get(name) !== snapshot.get(name)) {
          throw new FirestoreAdminError('FIRESTORE_PRECONDITION_FAILED', 409);
        }
      }
      for (const write of writes) {
        assert.ok(write.update);
        documents.set(write.update.name, decodeFields(write.update.fields));
      }
      transactions.delete(transaction);
      return {};
    },
    async rollback(transaction: string) { transactions.delete(transaction); },
  } satisfies Parameters<typeof recordAuthorSave>[0];
  return { documents, admin };
}

test('a verified account with no preference contributes its first save', async () => {
  const { documents, admin } = fixture();
  documents.delete(consent);
  await recordAuthorSave(admin, 'alice', event('openalex:W42'), ['openalex:W42']);
  assert.deepEqual(documents.get(week), {
    metric: 'saves', weekStart: '2026-11-23', paperIds: ['openalex:W42'],
  });
});

test('simultaneous DOI, arXiv and OpenAlex saves and a later replay contribute once', async () => {
  const { documents, admin } = fixture();
  documents.set(alias('arxiv:2611.12345'), { canonicalId: 'doi:10.1234/example' });
  const ids = ['doi:10.1234/example', 'openalex:W42'];
  await Promise.all([
    recordAuthorSave(admin, 'alice', event('openalex:W42'), ids),
    recordAuthorSave(admin, 'alice', event('doi:10.1234/Example'), ids),
    recordAuthorSave(admin, 'alice', event('2611.12345v2'), ['arxiv:2611.12345']),
  ]);
  documents.set(receiptPath('openalex:W42'), saved('openalex:W42', monday + 1000));
  await recordAuthorSave(admin, 'alice', event('openalex:W42', monday + 1000), ['openalex:W42']);
  assert.deepEqual(documents.get(week), {
    metric: 'saves', weekStart: '2026-11-23', paperIds: ['doi:10.1234/example'],
  });
  const nextMonday = Date.parse('2026-11-30T00:00:00Z');
  documents.set(receiptPath('openalex:W42'), saved('openalex:W42', nextMonday));
  documents.set(openAlex, { savedAt: new Date(nextMonday) });
  await recordAuthorSave(admin, 'alice', event('openalex:W42', nextMonday), ['openalex:W42']);
  assert.deepEqual(documents.get('users/alice/authorMetricWeeks/saves-2026-11-30'), {
    metric: 'saves', weekStart: '2026-11-30', paperIds: ['doi:10.1234/example'],
  });
});

test('skips the launch week, old and untrusted timestamps, disabled collection, and accounts that opted out', async () => {
  const id = 'openalex:W42';
  const path = receiptPath(id);
  const cases: Array<[string, object | null, number]> = [
    [path, saved(id, monday - 1), monday - 1],
    [path, saved(id, monday - 1), monday],
    [path, saved(id, monday - 120_001), monday],
    [path, { paperId: id, savedAt: '2026-11-23T00:00:00Z' }, monday],
    [path, saved('openalex:W43'), monday],
    [path, saved(id, monday + 1), monday],
    [config, { enabled: false, launchedAt: new Date('2026-11-20T12:00:00Z') }, monday],
    [account, null, monday],
    [account, { authorMetricsDeleting: true }, monday],
    [consent, { enabled: false }, monday],
    [consent, { enabled: true, changedAt: new Date(monday + 1) }, monday + 1],
    [openAlex, null, monday],
    [openAlex, { savedAt: new Date(monday - 120_001) }, monday],
  ];
  for (const [path, value, now] of cases) {
    const { documents, admin } = fixture();
    if (value) documents.set(path, value);
    else documents.delete(path);
    await recordAuthorSave(admin, 'alice', event(id, now), [id]);
    assert.equal([...documents.keys()].some(key => key.includes('/authorMetricWeeks/')), false, path);
  }
});

test('a Sunday receipt arriving after UTC midnight credits the week the save happened', async () => {
  const { documents, admin } = fixture();
  const nextMonday = Date.parse('2026-11-30T00:00:00Z');
  const id = 'openalex:W42';
  documents.set(openAlex, { savedAt: new Date(nextMonday + 100) });
  documents.set(receiptPath(id), saved(id, nextMonday - 100));
  documents.set('users/alice/authorMetricReceipts/second-tab', saved(id, nextMonday + 100));
  await recordAuthorSave(admin, 'alice', { paperId: id, receipt: 'second-tab', now: nextMonday + 100 }, [id]);
  await recordAuthorSave(admin, 'alice', event(id, nextMonday + 200), [id]);
  assert.deepEqual(documents.get(week), {
    metric: 'saves', weekStart: '2026-11-23', paperIds: ['openalex:W42'],
  });
  assert.deepEqual(documents.get('users/alice/authorMetricWeeks/saves-2026-11-30'), {
    metric: 'saves', weekStart: '2026-11-30', paperIds: ['openalex:W42'],
  });
});

test('a Monday receipt for a saved copy stamped before midnight credits Sunday', async () => {
  const { documents, admin } = fixture();
  const nextMonday = Date.parse('2026-11-30T00:00:00Z');
  const id = 'openalex:W42';
  documents.set(openAlex, { savedAt: new Date(nextMonday - 100) });
  documents.set(receiptPath(id), saved(id, nextMonday + 100));
  await recordAuthorSave(admin, 'alice', event(id, nextMonday + 200), [id]);
  assert.deepEqual(documents.get(week), {
    metric: 'saves', weekStart: '2026-11-23', paperIds: ['openalex:W42'],
  });
  assert.equal(documents.has('users/alice/authorMetricWeeks/saves-2026-11-30'), false);
});

test('an OpenAlex work with a journal DOI and a provider-supplied arXiv location joins either save order', async t => {
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(url.origin + url.pathname, 'https://api.openalex.org/works/W42');
    return Response.json({
      id: 'https://openalex.org/W42',
      doi: 'https://doi.org/10.1234/example',
      locations: [{ landing_page_url: 'https://arxiv.org/abs/2611.12345' }],
    });
  });
  const openAlexIds = await verifiedIdentifiers('openalex:W42', {});
  assert.deepEqual(openAlexIds, ['doi:10.1234/example', 'arxiv:2611.12345', 'openalex:W42']);

  for (const order of [
    [['2611.12345v2', ['arxiv:2611.12345']], ['openalex:W42', openAlexIds]],
    [['openalex:W42', openAlexIds], ['2611.12345v2', ['arxiv:2611.12345']]],
  ] satisfies Array<Array<[string, string[]]>>) {
    const { documents, admin } = fixture();
    for (const [paperId, ids] of order) await recordAuthorSave(admin, 'alice', event(paperId), ids);
    const canonicalId = order[0][1][0];
    assert.deepEqual(documents.get(week), { metric: 'saves', weekStart: '2026-11-23', paperIds: [canonicalId] });
    assert.deepEqual(documents.get(alias('arxiv:2611.12345')), { canonicalId });
    assert.deepEqual(documents.get(alias('openalex:W42')), { canonicalId });
  }
});

test('PubMed input is linked only when the OpenAlex work confirms the same PubMed ID', async t => {
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.match(url.pathname, /^\/works\/pmid:(123|321)$/);
    return Response.json({ id: 'https://openalex.org/W42', ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/123' } });
  });
  assert.deepEqual(await verifiedIdentifiers('pmid:123', {}), ['openalex:W42', 'pmid:123']);
  assert.deepEqual(await verifiedIdentifiers('pmid:321', {}), []);
});

test('the last weekly slot cannot be spent by two different papers', async () => {
  const { documents, admin } = fixture();
  const paperIds = Array.from({ length: 99 }, (_, index) => `openalex:W${index + 100}`);
  documents.set(week, { metric: 'saves', weekStart: '2026-11-23', paperIds });
  documents.set('users/alice/savedPapers/W43', { savedAt: new Date(monday) });
  documents.set(receiptPath('W43'), saved('W43'));
  documents.set(alias('openalex:W42'), { canonicalId: 'doi:10.1234/example' });
  documents.set(alias('openalex:W43'), { canonicalId: 'openalex:W43' });
  await Promise.all([
    recordAuthorSave(admin, 'alice', event('openalex:W42'), ['openalex:W42']),
    recordAuthorSave(admin, 'alice', event('W43'), ['openalex:W43']),
  ]);
  const stored = documents.get(week);
  assert.ok(stored && 'paperIds' in stored && Array.isArray(stored.paperIds));
  assert.equal(stored.paperIds.length, 100);
  assert.deepEqual(stored.paperIds.slice(0, 99), paperIds);
  assert.ok(['doi:10.1234/example', 'openalex:W43'].includes(stored.paperIds[99]));
});
