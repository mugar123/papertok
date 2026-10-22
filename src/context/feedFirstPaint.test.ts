import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests: FeedContext is a React context this repo cannot mount under
 * node. They pin the contract, not the implementation.
 *
 * Comments are prose, not code. Every scan below runs on stripped code, the
 * way analyticsPageviews.test.ts does, so a comment quoting the fix can never
 * stand in for the fix — these very files carry comments that name the bug.
 */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code: string, from: string, to: string, label: string, maxLines: number) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

test('SOURCE: the PubMed adapter itself stays free of browser-side enrichment', async () => {
  const code = stripComments(await read('../services/adapters/PubmedAdapter.ts'));
  assert.doesNotMatch(code, /enrichPubmedIds|openAlexJson/,
    'PubmedAdapter.test.ts forbids extra fetches inside fetchSearch');
});

/**
 * ade641a capped the concept sample at 24 ids, but fed it the Sets
 * the lists render, which `orderedSet` sorts by document id. The cap then
 * kept the alphabetically-first likes forever: the overlay never followed
 * what the reader had actually been liking (audit 2026-09-02, A3).
 */
test('SOURCE: the semantic sample is the most recent likes, not the lowest ids', async () => {
  const code = stripComments(await read('./FeedContext.tsx'));
  assert.match(
    code,
    /selectSemanticProfilePositiveIds\(\s*curatedIds\(profile, 'liked'\),\s*curatedIds\(profile, 'saved'\)\s*\)/,
    'the cap must read the aggregate order (newest first), never the id-sorted Sets',
  );
  // `orderedSet` still exists and still sorts — the lists need that order.
  // It must simply never be what the semantic overlay samples.
  assert.doesNotMatch(code, /selectSemanticProfilePositiveIds\((?:liked|saved)\b/,
    'the id-sorted Sets must not be handed to the cap');
});

/**
 * ade641a dropped the followed-topic category ids from the main query to get
 * `await loadTopicRetrieval()` off the critical path. Those topics then only
 * reached the feed through fetchFollowedEntityCandidates: four follows at
 * random, three papers each, six in total (audit 2026-09-02, A4). They rank
 * the query again — but budgeted, and against a prewarmed module.
 */
test('SOURCE: followed topics rank the main query again, inside a budget', async () => {
  const code = stripComments(await read('./FeedContext.tsx'));
  assert.match(code, /const FOLLOWED_TOPIC_RANK_BUDGET_MS = 300;/);
  const ranked = bounded(
    code,
    'const followedTopicIds = ',
    'const rankedPreferences = ',
    'the followed-topic lookup',
    14,
  );
  // One contiguous regex: the await must be wrapped in resolveWithin with the
  // named budget and an empty fallback. Checking `resolveWithin` and the
  // constant separately would pass on an unbounded await sitting next to an
  // unused budget constant.
  assert.match(
    ranked,
    /await resolveWithin\(\s*loadTopicRetrieval\(\)\.then\(module => module\.getFollowedTopicCategoryIds\(followedEntities\)\),\s*FOLLOWED_TOPIC_RANK_BUDGET_MS,\s*\[\],\s*\)/,
    'the lookup is budgeted and falls back to "no topic ids", never to a throw',
  );
  assert.match(
    code,
    /const rankedPreferences = rankPreferences\(\[\.\.\.userPreferences, \.\.\.followedTopicIds\], profileSignals\.current\.categoryAffinities\);/,
    'and the ids actually widen the ranked preferences, ranked with ties spread across areas',
  );
  assert.doesNotMatch(code, /const rankedPreferences = \[\.\.\.new Set\(/, 'the inline stable sort is gone: it kept taxonomy order on a flat profile');
});

test('SOURCE: the topic table is prewarmed when a topic follow is known', async () => {
  const code = stripComments(await read('./FeedContext.tsx'));
  const effect = bounded(
    code,
    'const followingSignatureRef = useRef<string | null>(null);',
    'const signature = followedEntities',
    'the following effect',
    12,
  );
  assert.match(
    effect,
    /if \(followedEntities\.some\(entity => entity\?\.type === 'topic'\)\) void loadTopicRetrieval\(\);/,
    'the 32 KB topic table loads off the critical path, so loadPapers meets it resident',
  );
});
