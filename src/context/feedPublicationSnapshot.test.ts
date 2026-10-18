import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('./FeedContext.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function feedSnapshotKey(');
const end = source.indexOf('// ── Demo mode storage helpers', start);
assert.ok(start >= 0 && end > start);
const helpers = stripTypeScriptTypes(source.slice(start, end));

test('old unchecked snapshots are refreshed, while current snapshots preserve scientific reviews and account isolation', () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => stored.set(key, value) };
  const { feedSnapshotKey, readFeedSnapshot, writeFeedSnapshot } = new Function(
    'localStorage', 'FEED_SNAPSHOT_TTL_MS', 'FEED_SNAPSHOT_MAX_PAPERS',
    `${helpers}; return { feedSnapshotKey, readFeedSnapshot, writeFeedSnapshot };`,
  )(storage, 15 * 60 * 1000, 30);
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    savedAt: Date.now(), papers: [{ id: 'W568341909', publicationType: 'article' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null);
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    publicationPolicy: 1, savedAt: Date.now(), papers: [{ id: 'openalex:W1503277431', publicationType: 'article' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null);
  const papers = [{ id: 'scientific-review', publicationType: 'review' }];
  writeFeedSnapshot('test-user', 'math.AG', { papers, page: 2, hasMore: true });
  assert.deepEqual(readFeedSnapshot('test-user', 'math.AG').papers, papers);
  assert.equal(readFeedSnapshot('test-user', 'math.AG').page, 2);
  assert.equal(readFeedSnapshot('different-user', 'math.AG'), null);
});
