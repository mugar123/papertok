import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests: FeedContext is a React context this repo cannot mount under
 * node. They pin the contract, not the implementation.
 *
 * Comments are prose, not code. Every scan below runs on stripped code, the
 * way analyticsPageviews.test.js does, so a comment quoting the fix can never
 * stand in for the fix — these very files carry comments that name the bug.
 */
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
 * ef82a42 painted as soon as one source had a page, and dropped what the
 * others returned afterwards. The late answers must be kept and consumed.
 */
test('SOURCE: the feed keeps what the slower sources return after the first paint', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const block = bounded(
    code,
    'const { first, all } = settleSourcesForFirstPaint(',
    'mainSourceResults = sourceResults;',
    'the first-paint block',
    30,
  );
  // Tied in one contiguous regex: the late results must be filtered against
  // the papers that actually painted and stored under a session guard. Three
  // loose substrings would pass on code that stored the unfiltered pool, or
  // stored it for a session the reader has already left.
  assert.match(
    block,
    /all\.then\(\(settled\) => \{\s*if \(feedSessionId\.current !== activeSessionId\) return;\s*lateSourceCandidatesRef\.current = lateSourceCandidates\(painted, settled\);/,
    'the late papers are filtered against what painted, guarded by session, and stored',
  );
  assert.match(block, /const painted = mainPapers;/, 'what painted is captured before the late merge');
});

test('SOURCE: the next page pools the late candidates and then forgets them', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const pool = bounded(
    code,
    'const lateMain = lateSourceCandidatesRef.current.splice(0);',
    'const uniqueMap = new Map();',
    'the candidate pool',
    12,
  );
  // `.splice(0)` in the same statement that names the pool: reading without
  // draining would offer the same papers on every later page.
  assert.match(pool, /const allFetched = \[\.\.\.mainPapers, \.\.\.lateMain, /,
    'the late candidates join the pool of the next page');

  const reset = bounded(
    code,
    'openAlexEnrichmentAttempts.current.clear();',
    'setLoading(true);',
    'the reset block',
    12,
  );
  assert.match(reset, /lateSourceCandidatesRef\.current = \[\];/,
    'a reset (new session, preference change) starts with an empty pool');
});
