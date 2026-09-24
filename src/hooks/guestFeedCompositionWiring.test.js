import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The guest page's rules live in `utils/guestFeedComposition.js` and are
// tested there against the audit's five arrival orders. The hook cannot be
// mounted under Node, so this pins that its load goes through them: readiness,
// the early page and the late pool.
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  assert.ok(block.split('\n').length <= maxLines, `${label} capture spans past what it names`);
  return block;
}

const load = bounded(
  stripComments(readFileSync(new URL('./useGuestFeed.js', import.meta.url), 'utf8')),
  'const load = useCallback(',
  '}, []);',
  'the guest load',
  90,
);

test('the first paint waits for every chosen area', () => {
  assert.match(
    load,
    /settleSourcesForFirstPaint\(\s*startGuestCandidateRequests\(requestedPlan, \{ refresh: forceRefresh \}\),\s*GUEST_SOURCE_BUDGET_MS,\s*\(papers\) => guestPageReady\(PaperBuilder\.deduplicate\(papers\), requestedPlan, GUEST_PAGE_SIZE\),\s*\)/,
  );
});

test('the early page is dealt by area, and the late pool extends it without moving it', () => {
  assert.match(
    load,
    /const early = composeGuestPage\(\s*dedupePapers\(PaperBuilder\.deduplicate\(fulfilledPaperLists\(await first\)\)\),\s*requestedPlan,\s*GUEST_PAGE_SIZE,\s*\);/,
  );
  assert.match(load, /setPapers\(extendGuestPage\(\[\], late, requestedPlan, GUEST_PAGE_SIZE\)\);/);
  assert.match(load, /setPapers\(\(current\) => extendGuestPage\(current, late, requestedPlan, GUEST_PAGE_SIZE\)\);/);
  assert.doesNotMatch(load, /\.slice\(0, GUEST_PAGE_SIZE\)/);
});
