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

/**
 * ade641a took Europe PMC out of PubmedAdapter.fetchSearch so PubMed would
 * stop losing the first-page race, and nothing picked it up again: the cards
 * lost open access, the PMC PDF, citations and the biomedical terms. It
 * belongs after the paint, never in front of it.
 */
test('SOURCE: PubMed cards get Europe PMC after paint, never before setPapers', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  // Tied in one regex: the request must be built from the pmids of the page
  // that was just selected (`iCitePmids`), and it must sit AFTER the promise
  // that iCite already builds from those same ids — which is itself after
  // `filtered` is final. A loose `enrichPubmedIds(` would pass on a call
  // placed in front of the first paint.
  assert.match(
    code,
    /const iCitePromise = fetchICiteMetrics\(iCitePmids\);[\s\S]{0,400}?const europePmcPromise = enrichPubmedIds\(iCitePmids\)\.catch\(/,
    'Europe PMC is requested next to iCite, from the painted page\'s pmids',
  );
  const merge = bounded(
    code,
    'europePmcPromise.then((lateRecords) => {',
    '} catch {',
    'the Europe PMC late merge',
    20,
  );
  assert.match(
    merge,
    /if \(feedSessionId\.current !== activeSessionId \|\| !lateRecords \|\| lateRecords\.size === 0\) return;\s*setPapers\(current => \{\s*const enriched = mergeEuropePmcEnrichment\(current, lateRecords\);/,
    'merged into state under the session guard, with the identity-preserving helper',
  );
});

test('SOURCE: the guest feed enriches its PubMed cards too', async () => {
  const code = stripComments(await read('../hooks/useGuestFeed.js'));
  const enrich = bounded(code, 'const enrichVisible = (batch) => {', '};', 'enrichVisible', 22);
  assert.match(
    enrich,
    /const pmids = \[\.\.\.new Set\(batch\.map\(paper => paper\?\.pmid\)\.filter\(Boolean\)\)\];\s*if \(pmids\.length > 0\) \{\s*enrichPubmedIds\(pmids\)/,
    'the pmids of the batch on screen are asked for',
  );
  assert.match(enrich, /setPapers\(\(current\) => mergeEuropePmcEnrichment\(current, lateRecords\)\);/);
  // The OpenAlex half must not early-return past the pmid half.
  assert.doesNotMatch(enrich, /if \(ids\.length === 0\) return;/,
    'an early return on the OpenAlex ids would skip Europe PMC entirely');
});

test('SOURCE: the PubMed adapter itself stays free of browser-side enrichment', async () => {
  const code = stripComments(await read('../services/adapters/PubmedAdapter.js'));
  assert.doesNotMatch(code, /enrichPubmedIds|openAlexJson/,
    'PubmedAdapter.test.js forbids extra fetches inside fetchSearch');
});

/**
 * ade641a capped the OpenAlex concept sample at 24 ids, but fed it the Sets
 * the lists render, which `orderedSet` sorts by document id. The cap then
 * kept the alphabetically-first likes forever: the overlay never followed
 * what the reader had actually been liking (audit 2026-09-02, A3).
 */
test('SOURCE: the semantic sample is the most recent likes, not the lowest ids', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(
    code,
    /const positiveIds = selectSemanticProfilePositiveIds\(\s*curatedIds\(profile, 'liked'\),\s*curatedIds\(profile, 'saved'\),\s*\);/,
    'the cap must read the aggregate order (newest first), never the id-sorted Sets',
  );
  // `orderedSet` still exists and still sorts — the lists need that order.
  // It must simply never be what the semantic overlay samples.
  assert.doesNotMatch(code, /selectSemanticProfilePositiveIds\((?:liked|saved)\b/,
    'the id-sorted Sets must not be handed to the cap');
});
