import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchFollowingUpdates } from './followingUpdatesService.js';

test('retrieves query-topic updates with stored metadata and preserves the full follow match', async () => {
  const follow = {
    type: 'topic',
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
        papers: [{ id: 'paper-1', title: 'Spatial transcriptomics maps tissue' }],
        allFailed: false,
      };
    },
  });

  assert.equal(receivedFollow, follow);
  assert.equal(receivedOptions.allowLegacyDisplayName, true);
  assert.equal(result.failedEntities, 0);
  assert.equal(result.papers.length, 1);
  assert.deepEqual(result.papers[0]._followedEntityMatches, [{
    type: 'topic',
    canonicalId: follow.canonicalId,
    displayName: follow.displayName,
    source: 'papertok',
    externalIds: {},
    metadata: follow.metadata,
  }]);
});

test('counts a failed topic independently and returns successful topic updates', async () => {
  const follows = [
    { type: 'topic', canonicalId: 'query-deadbeef', displayName: 'First', metadata: { query: 'First topic' } },
    { type: 'topic', canonicalId: 'query-feedface', displayName: 'Second', metadata: { query: 'Second topic' } },
  ];
  const result = await fetchFollowingUpdates(follows, {
    topicRetriever: async follow => {
      if (follow.canonicalId === 'query-deadbeef') throw new Error('provider unavailable');
      return { papers: [{ id: 'paper-2', title: 'Second topic result' }], allFailed: false };
    },
  });

  assert.equal(result.checkedEntities, 2);
  assert.equal(result.failedEntities, 1);
  assert.deepEqual(result.papers.map(paper => paper.id), ['paper-2']);
});

test('answers as each follow answers: the OpenAlex-backed ones first, everything merged as it lands', async () => {
  const follows = [
    { type: 'author', canonicalId: 'ada lovelace', displayName: 'Ada Lovelace' },
    { type: 'author', canonicalId: 'A1', displayName: 'Alan Turing', externalIds: { openalex: 'https://openalex.org/A1' } },
    { type: 'topic', canonicalId: 'cs.NI', displayName: 'Networking', metadata: { categoryIds: ['cs.NI'] } },
    { type: 'institution', canonicalId: '042nb2s44', displayName: 'MIT', externalIds: { ror: 'https://ror.org/042nb2s44' } },
  ];
  const started = [];
  const progress = [];
  const result = await fetchFollowingUpdates(follows, {
    fetchUpdatesForFollow: async (follow) => {
      started.push(follow.displayName);
      await new Promise(resolve => setTimeout(resolve, follow.type === 'institution' ? 30 : 5));
      return [{ id: `paper-${follow.canonicalId}`, title: follow.displayName, published: '2026-08-01' }];
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
  assert.deepEqual([...progress.at(-1).papers].sort(), result.papers.map(paper => paper.id).sort(), 'the last delivery is the answer');
  assert.equal(result.checkedEntities, 4);
});

test('a follow that never answers is counted as failed at the deadline, and the rest still arrive', async () => {
  const follows = [
    { type: 'author', canonicalId: 'A1', displayName: 'Alan Turing' },
    { type: 'author', canonicalId: 'A2', displayName: 'Stalled' },
  ];
  const result = await fetchFollowingUpdates(follows, {
    entityTimeoutMs: 20,
    fetchUpdatesForFollow: (follow) => (follow.canonicalId === 'A2'
      ? new Promise(() => {})
      : Promise.resolve([{ id: 'p1', title: 'On computable numbers', published: '2026-08-01' }])),
  });
  assert.equal(result.checkedEntities, 2);
  assert.equal(result.failedEntities, 1);
  assert.deepEqual(result.papers.map(paper => paper.id), ['p1']);
});

test('a category topic in the inbox asks for what is new in the category, not for what matches its name', async () => {
  let received;
  const retriever = async (topic, options) => { received = options; return { papers: [], allFailed: false }; };
  await fetchFollowingUpdates([
    { type: 'topic', canonicalId: 'cs.NI', displayName: 'Networking', metadata: { categoryIds: ['cs.NI'] } },
  ], { topicRetriever: retriever });
  assert.deepEqual(received.excludeProviders, ['searchArxiv', 'searchPubmed']);

  await fetchFollowingUpdates([
    { type: 'topic', canonicalId: 'query-3f419c36', displayName: 'Spatial transcriptomics', metadata: { query: 'Spatial transcriptomics', categoryIds: [] } },
  ], { topicRetriever: retriever });
  assert.equal(received.excludeProviders, undefined, 'a query topic has only the searches to answer with');
});
