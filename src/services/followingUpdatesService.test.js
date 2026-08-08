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
