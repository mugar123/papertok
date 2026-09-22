import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * SOURCE tests: the provider is a React context this repo cannot mount under
 * node. They pin what keeps a seen mark off the scroll path.
 *
 * Marking a card seen used to mint a new `markSeen` (it read `seenIds` state
 * and listed it as a dependency). FollowingFeedPage folds `markSeen` into the
 * `source` it hands FeedContainer, and FeedContainer's per-card callbacks
 * derive from `source`, so every mounted PaperCard lost its memo, re-rendered
 * and re-subscribed its IntersectionObserver on the frame the outgoing card
 * crossed the half-way mark — measured 2026-09-22 (production bundle, 23
 * cards, 4x CPU throttle) as two full-feed renders of 100-135 ms each inside
 * the snap animation. The persisted write ran in that same task and
 * re-serialised the whole local state, abstracts included.
 */
test('SOURCE: markSeen keeps one identity for the whole session', async () => {
  const code = stripComments(await read('./FollowingUpdatesContext.jsx'));
  const markSeen = bounded(code, 'const markSeen = useCallback(', '}, [scheduleSeenPersist]);', 'markSeen', 30);
  assert.match(markSeen, /if \(!key \|\| seenIdsRef\.current\.has\(key\)\) return;/, 'the early return reads the ref, not the state');
  assert.doesNotMatch(markSeen, /\bseenIds\b(?!Ref)/, 'no read of `seenIds` state anywhere in the callback');
  assert.match(markSeen, /seenIdsRef\.current = next;\s*setSeenIds\(next\);\s*scheduleSeenPersist\(\);/, 'the state still updates once per batch; the write is only scheduled');
  const schedule = bounded(code, 'const scheduleSeenPersist = useCallback(', '}, [flushSeenPersist]);', 'scheduleSeenPersist', 8);
  assert.match(schedule, /if \(pendingSeenPersistRef\.current\) return;/, 'one timer, however many cards a fling crosses');
  assert.match(schedule, /setTimeout\(flushSeenPersist, SEEN_PERSIST_DELAY_MS\)/);
});

test('SOURCE: the persisted write waits for a still feed and always carries the freshest set', async () => {
  const code = stripComments(await read('./FollowingUpdatesContext.jsx'));
  const delay = code.match(/const SEEN_PERSIST_DELAY_MS = (\d+);/);
  assert.ok(delay, 'the delay is a named constant');
  const ms = Number(delay[1]);
  assert.ok(ms >= 1000 && ms <= 3000, `${ms}ms: longer than a snap and its settle, short enough to land before the reader leaves`);
  const flush = bounded(code, 'const flushSeenPersist = useCallback(', '}, [persistSeenIds]);', 'flushSeenPersist', 10);
  assert.match(flush, /clearTimeout\(pending\.timer\);\s*pendingSeenPersistRef\.current = null;\s*void persistSeenIds\(\[\.\.\.seenIdsRef\.current\]\);/,
    'the flush writes what is current at flush time, never a snapshot taken earlier');
});

test('SOURCE: a tab hidden or closed inside the delay flushes first', async () => {
  const code = stripComments(await read('./FollowingUpdatesContext.jsx'));
  const effect = bounded(code, "window.addEventListener('pagehide', flushSeenPersist);", '}, [flushSeenPersist]);', 'the flush-on-hide effect', 10);
  assert.match(code, /if \(document\.visibilityState === 'hidden'\) flushSeenPersist\(\);/);
  assert.match(effect, /document\.addEventListener\('visibilitychange', handleVisibilityChange\);/);
  assert.match(effect, /window\.removeEventListener\('pagehide', flushSeenPersist\);[\s\S]*flushSeenPersist\(\);/, 'and the cleanup flushes too, so a sign-out loses nothing');
});
