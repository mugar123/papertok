import assert from 'node:assert/strict';
import test from 'node:test';
import { withStubbedFetch } from '../test-support/deadline-harness.ts';
import { CACHE } from './open-aire-service.ts';
import { openAlexClient } from './open-alex-client.ts';
import { fetchFollowingUpdates, orderFollowsForRefresh } from './following-updates-service.ts';
import type { Paper } from '../models/paper.ts';
import type { FollowEntity } from '../utils/following.ts';

const emptyOpenAire = () => Response.json({ header: { numFound: 0 }, results: [] });

/** Runs one project follow through the real chain and returns the URLs it asked for. */
async function urlsForProjectFollow(follow: Partial<FollowEntity> & Pick<FollowEntity, 'canonicalId'>) {
  const urls: string[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(async (url) => { urls.push(String(url)); return emptyOpenAire(); }, () => (
      fetchFollowingUpdates([{ type: 'project' as const, displayName: 'Quantum leap', source: 'openaire', ...follow }])
    ));
  } finally {
    CACHE.clear();
  }
  return urls;
}

test('retrieves query-topic updates with stored metadata and preserves the full follow match', async () => {
  const follow = {
    type: 'topic' as const,
    canonicalId: 'query-3f419c36',
    displayName: 'Spatial transcriptomics',
    source: 'papertok',
    externalIds: {},
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'pubmed',
      categoryIds: [],
    },
  };
  let receivedFollow;
  let receivedOptions;
  const result = await fetchFollowingUpdates([follow], {
    topicRetriever: async (topic, options) => {
      receivedFollow = topic;
      receivedOptions = options;
      return {
        papers: [{ id: 'paper-1', title: 'Spatial transcriptomics maps tissue' }] as Paper[],
        allFailed: false,
      };
    },
  });

  assert.equal(receivedFollow, follow);
  assert.equal(receivedOptions!.allowLegacyDisplayName, true);
  assert.equal(result.failedEntities, 0);
  assert.equal(result.papers.length, 1);
  assert.deepEqual(result.papers[0]._followedEntityMatches, [{
    type: 'topic' as const,
    canonicalId: follow.canonicalId,
    displayName: follow.displayName,
    source: 'papertok',
    externalIds: {},
    metadata: follow.metadata,
  }]);
});

// ENG-123 (D7): the Following page asks OpenAlex for a followed journal's
// newest articles, as its lane in the corpus lists them: the journal as the
// primary location (not a repository copy), articles and reviews (OpenAlex
// types every paper of the Annual Review journals `review`), none dated after
// today. Each says which journal it came from.
test("a followed journal's updates are its newest articles, each naming the journal", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T12:00:00Z') });
  const previous = { storage: openAlexClient.storage, store: openAlexClient.persistentStore, fetchImpl: openAlexClient.fetchImpl };
  const memory = new Map<string, string>();
  openAlexClient.storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  openAlexClient.persistentStore = null;
  const urls: URL[] = [];
  openAlexClient.fetchImpl = async (url) => {
    urls.push(new URL(String(url)));
    return Response.json({ meta: { count: 2 }, results: [{
      id: 'https://openalex.org/W7000000001', type: 'article', title: 'Monetary policy and the term structure', publication_date: '2026-10-20',
      primary_location: { source: { id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' } },
    }, {
      id: 'https://openalex.org/W7000000002', type: 'review', title: 'Fifty years of the term structure: a review', publication_date: '2026-10-18',
      primary_location: { source: { id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' } },
    }] });
  };
  t.after(() => Object.assign(openAlexClient, { storage: previous.storage, persistentStore: previous.store, fetchImpl: previous.fetchImpl }));
  const journal = { type: 'journal' as const, canonicalId: 'S23254222', displayName: 'American Economic Review', source: 'openalex', externalIds: { issnl: '0002-8282' }, metadata: {} };

  const result = await fetchFollowingUpdates([journal]);

  assert.equal(urls.length, 1);
  assert.deepEqual(urls[0].searchParams.get('filter')!.split(',').sort(), ['primary_location.source.id:S23254222', 'to_publication_date:2026-10-25', 'type:article|review']);
  assert.equal(urls[0].searchParams.get('sort'), 'publication_date:desc');
  assert.equal(result.failedEntities, 0);
  assert.deepEqual(result.papers.map(paper => [paper.title, paper._followedEntityMatches]), [
    ['Monetary policy and the term structure', [journal]],
    ['Fifty years of the term structure: a review', [journal]],
  ]);
  assert.deepEqual(orderFollowsForRefresh([{ type: 'author', canonicalId: 'ada lovelace', displayName: 'Ada Lovelace' }, journal]).map(follow => follow.type), ['journal', 'author'],
    'one OpenAlex request, so it answers before the follows that wait for arXiv');
});

// ENG-123: a refresh asks for up to 40 follows, and journals are counted
// apart, up to 10. The follows arrive in Firestore document-id order, where
// `journal_…` sorts between `institution_…` and `topic_…`.
test('ten followed journals leave a heavy follower every other follow on the Following page', async () => {
  const many = (type: FollowEntity['type'], prefix: string, count: number) => Array.from({ length: count }, (_, index): FollowEntity => (
    { type, canonicalId: `${prefix}${100 + index}`, displayName: `${type} ${index}` }
  ));
  const follows = [
    ...many('author', 'A', 25),
    ...many('institution', 'I', 6),
    ...many('journal', 'S', 11),
    ...many('topic', 'T', 5),
  ];
  const asked: string[] = [];
  const result = await fetchFollowingUpdates(follows, {
    fetchUpdatesForFollow: async (follow) => { asked.push(follow.canonicalId); return []; },
  });

  assert.equal(asked.length, 46);
  assert.deepEqual(asked.filter(id => id.startsWith('T')).sort(), ['T100', 'T101', 'T102', 'T103', 'T104']);
  assert.equal(asked.filter(id => id.startsWith('S')).length, 10);
  assert.equal(asked.includes('S110'), false, 'an eleventh journal, stored from two devices at once, is not asked for');
  assert.equal(result.checkedEntities, 46);
});

test('counts a failed topic independently and returns successful topic updates', async () => {
  const follows = [
    { type: 'topic' as const, canonicalId: 'query-deadbeef', displayName: 'First', metadata: { query: 'First topic' } },
    { type: 'topic' as const, canonicalId: 'query-feedface', displayName: 'Second', metadata: { query: 'Second topic' } },
  ];
  const result = await fetchFollowingUpdates(follows, {
    topicRetriever: async follow => {
      if (follow.canonicalId === 'query-deadbeef') throw new Error('provider unavailable');
      return { papers: [{ id: 'paper-2', title: 'Second topic result' }] as Paper[], allFailed: false };
    },
  });

  assert.equal(result.checkedEntities, 2);
  assert.equal(result.failedEntities, 1);
  assert.deepEqual(result.papers.map(paper => paper.id), ['paper-2']);
});

test('answers as each follow answers: the OpenAlex-backed ones first, everything merged as it lands', async () => {
  const follows = [
    { type: 'author' as const, canonicalId: 'ada lovelace', displayName: 'Ada Lovelace' },
    { type: 'author' as const, canonicalId: 'A1', displayName: 'Alan Turing', externalIds: { openalex: 'https://openalex.org/A1' } },
    { type: 'topic' as const, canonicalId: 'cs.NI', displayName: 'Networking', metadata: { categoryIds: ['cs.NI'] } },
    { type: 'institution' as const, canonicalId: '042nb2s44', displayName: 'MIT', externalIds: { ror: 'https://ror.org/042nb2s44' } },
  ];
  const started: unknown[] = [];
  const progress: { papers: string[]; checked: number; failed: number; total: number }[] = [];
  const result = await fetchFollowingUpdates(follows, {
    fetchUpdatesForFollow: async (follow) => {
      started.push(follow.displayName);
      await new Promise(resolve => setTimeout(resolve, follow.type === 'institution' ? 30 : 5));
      return [{ id: `paper-${follow.canonicalId}`, title: follow.displayName, published: '2026-08-01' }] as Paper[];
    },
    onProgress: (partial) => progress.push({
      papers: partial.papers.map(paper => paper.id),
      checked: partial.checkedEntities,
      failed: partial.failedEntities,
      total: partial.totalEntities,
    }),
  });

  assert.deepEqual(started, ['Alan Turing', 'MIT', 'Ada Lovelace', 'Networking'],
    'the follows that resolve through OpenAlex start first; the ones bound to the arXiv chain go after');
  assert.equal(progress.length, 4, 'one delivery per follow');
  assert.deepEqual(progress.map(entry => entry.checked), [1, 2, 3, 4]);
  assert.ok(progress.every(entry => entry.total === 4 && entry.failed === 0));
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index - 1].papers.every(id => progress[index].papers.includes(id)), 'each delivery carries everything delivered before it');
  }
  assert.deepEqual([...progress.at(-1)!.papers].sort(), result.papers.map(paper => paper.id).sort(), 'the last delivery is the answer');
  assert.equal(result.checkedEntities, 4);
});

test('a follow that never answers is counted as failed at the deadline, and the rest still arrive', async () => {
  const follows = [
    { type: 'author' as const, canonicalId: 'A1', displayName: 'Alan Turing' },
    { type: 'author' as const, canonicalId: 'A2', displayName: 'Stalled' },
  ];
  const result = await fetchFollowingUpdates(follows, {
    entityTimeoutMs: 20,
    fetchUpdatesForFollow: (follow) => (follow.canonicalId === 'A2'
      ? new Promise(() => {})
      : Promise.resolve([{ id: 'p1', title: 'On computable numbers', published: '2026-08-01' }] as Paper[])),
  });
  assert.equal(result.checkedEntities, 2);
  assert.equal(result.failedEntities, 1);
  assert.deepEqual(result.papers.map(paper => paper.id), ['p1']);
});

test('a category topic in the inbox asks for what is new in the category, not for what matches its name', async () => {
  let received;
  const retriever: NonNullable<NonNullable<Parameters<typeof fetchFollowingUpdates>[1]>['topicRetriever']> = async (topic, options) => { received = options; return { papers: [], allFailed: false }; };
  await fetchFollowingUpdates([
    { type: 'topic' as const, canonicalId: 'cs.NI', displayName: 'Networking', metadata: { categoryIds: ['cs.NI'] } },
  ], { topicRetriever: retriever });
  assert.deepEqual(received!.excludeProviders, ['searchArxiv', 'searchPubmed']);

  await fetchFollowingUpdates([
    { type: 'topic' as const, canonicalId: 'query-3f419c36', displayName: 'Spatial transcriptomics', metadata: { query: 'Spatial transcriptomics', categoryIds: [] } },
  ], { topicRetriever: retriever });
  assert.equal(received!.excludeProviders, undefined, 'a query topic has only the searches to answer with');
});

/**
 * A grant code is not unique across funders — code 100010 answers for three
 * different projects — and the `canonicalId` of every project followed
 * before the OpenAIRE id landed is exactly such a bare code. The funder that
 * tells them apart is stored on the follow, and the digest was not passing
 * it: the same project whose own page shows 39 publications reached the email
 * as the mixed 51-row set.
 */
test('a project follow carries the funder stored on it into the OpenAIRE query', async () => {
  const urls = await urlsForProjectFollow({ canonicalId: '100010', metadata: { funder: 'SNSF' } });
  assert.equal(urls.length, 1, 'one OpenAIRE request, and nothing else to ask once it comes back empty');
  const request = new URL(urls[0]);
  assert.equal(request.pathname, '/graph/v3/research-products');
  assert.equal(request.searchParams.get('relProjectCode'), '100010');
  assert.equal(request.searchParams.get('relProjectFundingShortName'), 'SNSF');
});

test('a project follow with no stored funder asks exactly what it asked before', async () => {
  // Old follow documents have no `metadata.funder` at all; an absent funder
  // must leave the request untouched rather than send an empty one.
  const noMetadata = await urlsForProjectFollow({ canonicalId: 'snsf________::daa28096' });
  assert.equal(noMetadata.length, 1);
  const byId = new URL(noMetadata[0]).searchParams;
  assert.equal(byId.get('relProjectId'), 'snsf________::daa28096');
  assert.equal(byId.has('relProjectFundingShortName'), false);

  const emptyMetadata = await urlsForProjectFollow({ canonicalId: '100010', metadata: {} });
  const byCode = new URL(emptyMetadata[0]).searchParams;
  assert.equal(byCode.get('relProjectCode'), '100010');
  assert.equal(byCode.has('relProjectFundingShortName'), false);
});
