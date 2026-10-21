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

/**
 * ef82a42 painted as soon as one source had a page, and dropped what the
 * others returned afterwards. The late answers must be kept and consumed.
 */
test('SOURCE: the feed keeps what the slower sources return after the first paint', async () => {
  const code = stripComments(await read('./FeedContext.tsx'));
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
  // The guard names BOTH the session and the pool generation: a preference
  // change, a follow change or a refresh reset the feed without bumping the
  // session, and a query still in flight from before must not refill the
  // pool with candidates for the old preferences. And the answer APPENDS,
  // filtered against what painted and what is already pooled: the auto-fetch
  // path starts page N+1 before N's late answer lands, and an assignment
  // would let N+1's answer overwrite N's.
  assert.match(
    block,
    /all\.then\(\(settled\) => \{\s*if \(feedSessionId\.current !== activeSessionId \|\| latePoolGenerationRef\.current !== poolGeneration\) return;\s*const pooled = lateSourceCandidatesRef\.current;\s*lateSourceCandidatesRef\.current = \[\.\.\.pooled, \.\.\.lateSourceCandidates\(\[\.\.\.painted, \.\.\.pooled\], settled\)\];/,
    'the late papers are filtered against what painted and what is pooled, guarded by session and generation, and appended',
  );
  assert.match(block, /const painted = mainPapers;/, 'what painted is captured before the late merge');
});

test('SOURCE: the next page pools the late candidates and then forgets them', async () => {
  const code = stripComments(await read('./FeedContext.tsx'));
  const pool = bounded(
    code,
    'const lateMain = lateSourceCandidatesRef.current.splice(0);',
    'const uniqueMap = new Map<string, Paper>();',
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
  assert.match(reset, /lateSourceCandidatesRef\.current = \[\];\s*latePoolGenerationRef\.current \+= 1;/,
    'a reset (new session, preference change) starts with an empty pool and a new generation');
  assert.match(code, /const poolGeneration = latePoolGenerationRef\.current;/,
    'and the generation is captured after the reset, so this load\'s own answers still count');
});

test('SOURCE: the PubMed adapter itself stays free of browser-side enrichment', async () => {
  const code = stripComments(await read('../services/adapters/PubmedAdapter.ts'));
  assert.doesNotMatch(code, /enrichPubmedIds|openAlexJson/,
    'PubmedAdapter.test.ts forbids extra fetches inside fetchSearch');
});

/**
 * ade641a capped the OpenAlex concept sample at 24 ids, but fed it the Sets
 * the lists render, which `orderedSet` sorts by document id. The cap then
 * kept the alphabetically-first likes forever: the overlay never followed
 * what the reader had actually been liking (audit 2026-09-02, A3).
 */
test('SOURCE: the semantic sample is the most recent likes, not the lowest ids', async () => {
  const code = stripComments(await read('./FeedContext.tsx'));
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

/**
 * Measured 2026-09-16: the optional candidates were created before the main
 * sources, so the feed's OpenAlex search entered the client's two-wide FIFO
 * queue behind every followed-entity lookup and left the browser 2.3 s late —
 * past its own first-paint budget. The main sources are issued first now, and
 * the feed's search takes the priority lane.
 */
test('SOURCE: the main sources are requested before the optional candidates, and the feed search has priority', async () => {
  const code = stripComments(await read('./FeedContext.tsx'));
  const block = bounded(
    code,
    "const queryMode = (temporalPreference.current || 0) < -0.3 ? 'relevance' : 'recent';",
    'let sourceResults = await first;',
    'the source fan-out',
    100,
  );
  const domainAt = block.indexOf('const domainProm = fetchDomainPapers(');
  const settleAt = block.indexOf('const { first, all } = settleSourcesForFirstPaint(');
  // The assignments that issue the requests, not the declarations above them.
  const graphAt = block.indexOf('graphCandidatesPromise = resolveWithin(');
  const followedAt = block.indexOf('followedCandidatesPromise = resolveWithin(');
  const personalAt = block.indexOf('personalCandidatesPromise = resolveWithin(');
  assert.ok(domainAt >= 0 && settleAt > domainAt, 'the main sources are issued inside the block');
  assert.ok(graphAt > domainAt && graphAt < settleAt, 'the graph candidates are asked for after the main sources have been issued');
  assert.ok(personalAt > domainAt && personalAt < settleAt, 'the personal recommendations are asked for after the main sources have been issued');
  assert.ok(followedAt > domainAt && followedAt < settleAt, 'the followed candidates are asked for after the main sources have been issued');
  assert.match(
    block,
    /\.search\(openAlexQuery, currentPage \+ 1, \{ internalCategories: openAlexCats, priority: true, requireAbstract: true \}\)/,
    'the feed search takes the priority lane of the OpenAlex queue',
  );
});
