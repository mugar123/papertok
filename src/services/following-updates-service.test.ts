import assert from 'node:assert/strict';
import test from 'node:test';
import { withStubbedFetch } from '../test-support/deadline-harness.ts';
import { CACHE } from './open-aire-service.ts';
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

// A refresh asks for up to 40 follows, those that answer through OpenAlex
// alone first: one request each, so they answer before the follows that wait
// for arXiv.
test('a refresh asks for the first 40 follows, the OpenAlex ones first', async () => {
  const many = (type: FollowEntity['type'], prefix: string, count: number) => Array.from({ length: count }, (_, index): FollowEntity => (
    { type, canonicalId: `${prefix}${100 + index}`, displayName: `${type} ${index}` }
  ));
  const follows = [...many('author', 'A', 25), ...many('institution', 'I', 6), ...many('topic', 'T', 11)];
  const asked: string[] = [];
  const result = await fetchFollowingUpdates(follows, {
    fetchUpdatesForFollow: async (follow) => { asked.push(follow.canonicalId); return []; },
  });

  assert.equal(asked.length, 40);
  assert.equal(asked.includes('T109') || asked.includes('T110'), false, 'the 41st and 42nd follows are not asked for');
  assert.equal(result.checkedEntities, 40);
  assert.deepEqual(orderFollowsForRefresh([{ type: 'author', canonicalId: 'ada lovelace', displayName: 'Ada Lovelace' }, follows[25]]).map(follow => follow.type), ['institution', 'author']);
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

// ENG-110 follow-up: with A and B on screen, a refresh in which A answered and
// B failed replaced the cards with A's, and B's known papers were gone until
// a refresh in which B answered.
test('a partial refresh keeps the papers on screen of the follows that have not answered it', async () => {
  const [ada, alan, grace] = [
    { type: 'author' as const, canonicalId: 'A1', displayName: 'Ada' },
    { type: 'author' as const, canonicalId: 'A2', displayName: 'Alan' },
    { type: 'author' as const, canonicalId: 'A3', displayName: 'Grace' },
  ];
  const match = (follow: FollowEntity) => ({ type: follow.type, canonicalId: follow.canonicalId });
  const shown = (id: string, ...follows: FollowEntity[]) => ({ id, title: id, published: '2026-08-01', _followedEntityMatches: follows.map(match) }) as Paper;
  // On screen: Ada's, Alan's, Grace's, one both Ada and Alan brought in, and
  // one of a follow the reader has since dropped.
  const previous = [
    shown('ada-old', ada), shown('alan-old', alan), shown('grace-old', grace),
    { ...shown('shared-old', ada, alan), journal: 'arXiv preprint' },
    shown('dropped-old', { type: 'author', canonicalId: 'A9', displayName: 'Dropped' }),
  ];
  const progress: string[][] = [];
  const result = await fetchFollowingUpdates([ada, alan, grace], {
    previous,
    fetchUpdatesForFollow: async (follow) => {
      // Ada answers with a new paper and an updated copy of the shared one,
      // Grace answers with none, Alan fails.
      if (follow === ada) {
        return [
          { id: 'ada-new', title: 'ada-new', published: '2026-09-01' },
          { id: 'shared-old', title: 'shared-old', published: '2026-08-01', journal: 'Nature' },
        ] as Paper[];
      }
      if (follow === grace) return [];
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('arXiv unavailable');
    },
    onProgress: partial => progress.push(partial.papers.map(paper => paper.id).sort()),
  });

  assert.deepEqual(result.papers.map(paper => paper.id).sort(), ['ada-new', 'alan-old', 'shared-old'],
    "Alan's papers stay; Ada's and Grace's answers replace theirs; the dropped follow's paper goes");
  const shared = result.papers.find(paper => paper.id === 'shared-old');
  assert.equal(shared?.journal, 'Nature', "Ada's fresh copy wins over the copy kept for Alan");
  assert.deepEqual(shared?._followedEntityMatches?.map(entry => typeof entry === 'string' ? entry : entry.canonicalId), ['A2', 'A1'],
    'a shared paper Ada brought in again is credited to both');
  assert.equal(result.failedEntities, 1, 'still a partial answer, so the next load asks again');
  assert.ok(progress.every(ids => ids.includes('alan-old')), "Alan's papers are on screen in every delivery");
  assert.deepEqual(progress[0], ['ada-new', 'alan-old', 'grace-old', 'shared-old'], 'a follow still on its way keeps its papers too');
  assert.ok(!progress.at(-1)!.includes('grace-old'), "Grace's empty answer is her answer");
});

// ENG-176: with the Worker unreachable every follow failed, and the refresh
// resolved with no papers. The page read that as nothing new: it dropped its
// cards, wrote the empty answer to its cache and said "Papers updated".
test('a refresh in which every follow failed rejects instead of answering with no papers', async () => {
  const follows = [
    { type: 'author' as const, canonicalId: 'A1', displayName: 'Alan Turing' },
    { type: 'author' as const, canonicalId: 'A2', displayName: 'Stalled' },
  ];
  await assert.rejects(fetchFollowingUpdates(follows, {
    entityTimeoutMs: 20,
    fetchUpdatesForFollow: (follow) => (follow.canonicalId === 'A2'
      ? new Promise(() => {})
      : Promise.reject(new Error('Worker unreachable'))),
  }), /All follows failed/);

  // One follow that answered, even with nothing recent, is an answer.
  const answered = await fetchFollowingUpdates(follows, {
    fetchUpdatesForFollow: async (follow) => {
      if (follow.canonicalId === 'A1') return [];
      throw new Error('Worker unreachable');
    },
  });
  assert.deepEqual(
    [answered.checkedEntities, answered.failedEntities, answered.papers.length],
    [2, 1, 0],
  );
  // And nothing followed is nothing to fail.
  assert.equal((await fetchFollowingUpdates([])).checkedEntities, 0);
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
