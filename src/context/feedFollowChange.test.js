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
 * SOURCE tests: FeedContext is a React context this repo cannot mount under
 * node. They pin what a follow change may do to the list on screen.
 *
 * Entering a paper's project from the feed, following it, unfollowing it and
 * coming back used to land on a different paper at the same index
 * (2026-09-07): the following effect replaced the whole list with a fresh
 * page — which never holds the card the reader is on, every painted paper
 * being in the seen set — and did so off the feed route, twice.
 */
test('SOURCE: a reset asked to keep the visible card merges the fresh page below it', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(code, /import \{ mergeFreshFeedPage, splitFeedForReRank \} from '\.\.\/utils\/feedReRankSplit\.js';/);
  assert.match(
    code,
    /const loadPapers = useCallback\(async \(reset = false, mode, randomizeStart = false, pageOverride, \{ keepThroughVisible = false \} = \{\}\) => \{/,
    'the option is an explicit parameter, not a ref the effect has to set',
  );
  const resetBranch = bounded(code, 'let nextPapers;', 'const nextHasMore =', 'the reset branch of loadPapers', 20);
  assert.match(
    resetBranch,
    /if \(reset\) \{\s*nextPapers = keepThroughVisible\s*\?\s*mergeFreshFeedPage\(papers, filtered, \{\s*anchorPaperIds: \[visiblePaperIdRef\.current\],?\s*\}\)\s*:\s*filtered;/,
    'through the visible card the list stays; the fresh page follows',
  );
});

test('SOURCE: the automatic retry after a failed reset keeps the option', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const retry = bounded(code, 'if (reset && !autoRetryUsedRef.current) {', '}, 2500);', 'the automatic retry', 8);
  assert.match(retry, /loadPapersRef\.current\?\.\(true, activeMode, false, undefined, \{ keepThroughVisible \}\);/);
});
