import test from 'node:test';
import assert from 'node:assert/strict';
import { feedSeedsForConnection, feedSeedsOf, feedSeedsWrite, sameDecisions } from './orcid-feed-seeds-service.ts';

const snapshot = (data: Record<string, unknown>) => ({ get: (field: string) => data[field] });
const CONNECTED_AT = '2026-11-20T10:00:00.000Z';

test('the kept publications count only for the connection they were read for', () => {
  const data = {
    connectedAt: CONNECTED_AT,
    feedSeeds: [{ id: 'openalex:W1', category: 'cs.CV' }, { id: 7 }, { id: 'openalex:W2' }],
    feedKeys: ['openalex:W1', 3, 'doi:10.1000/a'],
    feedAt: { toMillis: () => 1234 },
  };
  assert.deepEqual(feedSeedsForConnection(snapshot(data), CONNECTED_AT), {
    seeds: [{ id: 'openalex:W1', category: 'cs.CV' }, { id: 'openalex:W2', category: '' }],
    keys: ['openalex:W1', 'doi:10.1000/a'],
    keptAt: 1234,
  });
  assert.deepEqual(feedSeedsForConnection(snapshot(data), '2026-11-21T10:00:00.000Z'), { seeds: [], keys: [], keptAt: null });
  assert.deepEqual(feedSeedsForConnection(snapshot(data), null), { seeds: [], keys: [], keptAt: null });
  // A document with decisions only keeps no publications yet.
  assert.deepEqual(feedSeedsForConnection(snapshot({ connectedAt: CONNECTED_AT, mine: ['doi:10.1000/a'] }), CONNECTED_AT), { seeds: [], keys: [], keptAt: null });
});

test('keeping publications writes only their fields and leaves the decisions alone', () => {
  const write = feedSeedsWrite(CONNECTED_AT, { seeds: [{ id: 'openalex:W1', category: 'cs.CV' }], keys: ['openalex:W1'] });
  assert.deepEqual(Object.keys(write).sort(), ['connectedAt', 'feedAt', 'feedKeys', 'feedSeeds', 'updatedAt']);
  assert.deepEqual(write.feedSeeds, [{ id: 'openalex:W1', category: 'cs.CV' }]);
});

test('a decision made meanwhile is told apart from the same decisions in another order', () => {
  assert.equal(sameDecisions({ mine: ['a', 'b'], notMine: [] }, { mine: ['b', 'a'], notMine: [] }), true);
  assert.equal(sameDecisions({ mine: ['a'], notMine: [] }, { mine: ['a'], notMine: ['b'] }), false);
});

test('the works ORCID lists without an OpenAlex paper are left out of the feed, and a work marked not mine ranks nothing', () => {
  const work = { putCode: '1', title: 'A', year: 2025, type: 'journal-article', doi: '10.1000/a', externalIds: [{ type: 'doi', value: '10.1000/a' }] };
  const publications = [
    { kind: 'record' as const, work, paper: null },
    { kind: 'added' as const, key: 'openalex:W9', paper: null },
    { kind: 'record' as const, work: { ...work, doi: '10.1000/b', externalIds: [] }, paper: { id: 'openalex:W2', doi: '10.1000/b' } as never },
    { kind: 'record' as const, work: { ...work, doi: '10.1000/c', externalIds: [] }, paper: { id: 'openalex:W3', doi: '10.1000/c' } as never },
  ];
  const { seeds, keys } = feedSeedsOf(publications, { mine: [], notMine: ['doi:10.1000/c'] });
  assert.deepEqual(seeds.map(seed => seed.id), ['openalex:W2']);
  for (const key of ['doi:10.1000/a', 'openalex:W9', 'doi:10.1000/b', 'openalex:W2']) assert.ok(keys.includes(key), key);
  assert.ok(!keys.includes('openalex:W3'));
});
