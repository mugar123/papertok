import test from 'node:test';
import assert from 'node:assert/strict';
import { feedSeedsForConnection, feedSeedsWrite } from './orcid-feed-seeds-service.ts';

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
