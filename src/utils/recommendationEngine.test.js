import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCategoryAffinityDelta,
  applyRecommendationScore,
  diversifiedWeightedShuffle,
  FEED_SHUFFLE_POOL_CAP,
  mergeRecommendationWeights,
  scorePaperForRecommendation,
  trimScoredCandidatePool,
  weightedShuffle,
} from './recommendationEngine.js';

const NOW = new Date('2026-07-05T12:00:00Z').getTime();

test('selected user category dominates neutral papers', () => {
  const score = scorePaperForRecommendation(
    {
      id: 'paper-a',
      primaryCategory: 'cs.AI',
      allCategories: ['cs.AI'],
      published: '2026-07-05T00:00:00Z',
      authors: ['A. Researcher'],
    },
    {
      now: NOW,
      userPreferences: ['cs.AI'],
    }
  );

  assert.equal(score.preference, 100);
  assert.ok(score.total > 100);
  assert.match(score.explanation, /preference/);
});

test('cooldown suppresses recently rejected categories', () => {
  const noCooldown = scorePaperForRecommendation(
    {
      id: 'paper-a',
      primaryCategory: 'cs.LG',
      allCategories: ['cs.LG'],
      published: '2026-07-05T00:00:00Z',
    },
    {
      now: NOW,
      userPreferences: ['cs.LG'],
    }
  );

  const cooledDown = scorePaperForRecommendation(
    {
      id: 'paper-b',
      primaryCategory: 'cs.LG',
      allCategories: ['cs.LG'],
      published: '2026-07-05T00:00:00Z',
    },
    {
      now: NOW,
      userPreferences: ['cs.LG'],
      categoryCooldowns: {
        'cs.LG': NOW,
      },
    }
  );

  assert.equal(cooledDown.cooldownMultiplier, 0.1);
  assert.ok(cooledDown.total < noCooldown.total);
});

test('semantic and citation signals contribute to score', () => {
  const score = scorePaperForRecommendation(
    {
      id: 'paper-a',
      primaryCategory: 'cs.CL',
      published: '2025-01-01T00:00:00Z',
      openAlex: {
        cited_by_count: 99,
        concepts: [{ id: 'concept-1', score: 0.5 }],
      },
    },
    {
      now: NOW,
      conceptAffinities: { 'concept-1': 2 },
    }
  );

  assert.ok(score.semantic > 0);
  assert.ok(score.citations > 0);
  assert.match(score.explanation, /semantic|citations/);
});

test('category signals preserve personalization without OpenAlex enrichment', () => {
  const categoryAffinities = {};
  const paper = {
    id: 'paper-local',
    primaryCategory: 'physics.optics',
    allCategories: ['physics.optics', 'quant-ph'],
    published: '2026-07-01T00:00:00Z',
  };
  applyCategoryAffinityDelta(categoryAffinities, paper, 10);

  const score = scorePaperForRecommendation(paper, {
    now: NOW,
    userPreferences: ['quant-ph'],
    categoryAffinities,
  });

  assert.equal(categoryAffinities['physics.optics'], 10);
  assert.equal(categoryAffinities['quant-ph'], 3.5);
  assert.equal(score.semantic, 0);
  assert.equal(score.preference, 80);
  assert.ok(score.affinity > 10);
});

test('every score component is bounded by its designed maximum', () => {
  const extremeConcepts = Array.from({ length: 8 }, (_, index) => ({ id: `concept-${index}`, score: 1 }));
  const extremeAffinities = Object.fromEntries(extremeConcepts.map(concept => [concept.id, 100]));
  const score = scorePaperForRecommendation(
    {
      id: 'paper-extreme',
      primaryCategory: 'cs.AI',
      allCategories: ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'stat.ML'],
      published: '2010-01-01T00:00:00Z',
      openAlex: { cited_by_count: 5_000_000, concepts: extremeConcepts },
    },
    {
      now: NOW,
      categoryAffinities: { 'cs.AI': 100, 'cs.LG': 100, 'cs.CL': 100, 'cs.CV': 100, 'cs.NE': 100, 'stat.ML': 100 },
      conceptAffinities: extremeAffinities,
      temporalPreference: -1,
    }
  );

  assert.equal(score.affinity, 100);
  assert.equal(score.semantic, 20);
  assert.equal(score.citations, 25);
  assert.ok(score.classicBoost <= 25);
});

test('negative concept affinities subtract but stay bounded', () => {
  const score = scorePaperForRecommendation(
    {
      id: 'paper-negative',
      primaryCategory: 'cs.AI',
      published: '2026-07-01T00:00:00Z',
      openAlex: { concepts: [{ id: 'disliked', score: 1 }] },
    },
    {
      now: NOW,
      conceptAffinities: { disliked: -10 },
    }
  );

  assert.ok(score.semantic < 0);
  assert.ok(score.semantic >= -20);
});

test('stable followed entities boost papers and cap the combined signal', () => {
  const score = scorePaperForRecommendation({
    id: 'paper-followed',
    primaryCategory: 'physics.optics',
    authors: [{ id: 'https://openalex.org/A1', name: 'Ada' }],
    institutions: [{ id: 'https://openalex.org/I2', displayName: 'Institute' }],
    _followedEntityMatches: ['project-3'],
  }, {
    now: NOW,
    followedEntities: [
      { type: 'author', canonicalId: 'A1', displayName: 'Ada' },
      { type: 'topic', canonicalId: 'physics.optics', displayName: 'Optics' },
      { type: 'institution', canonicalId: 'I2', displayName: 'Institute' },
      { type: 'project', canonicalId: 'project-3', displayName: 'Project' },
    ],
  });

  assert.equal(score.followBoost, 70);
  assert.deepEqual(score.followedEntityMatches, { author: true, topic: true, institution: true, project: true });
});

test('matches followed topics directly across categories, concepts, topics, and keywords', () => {
  const queryFollow = {
    type: 'topic',
    canonicalId: 'query-1234abcd',
    displayName: 'Transcriptómica espacial',
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'pubmed',
      categoryIds: [],
    },
  };
  const categoryFollow = {
    type: 'topic',
    canonicalId: 'query-8765abcd',
    displayName: 'Optics',
    metadata: { query: 'Photonics', categoryIds: ['physics.optics'] },
  };
  const semanticPapers = [
    { categories: ['physics.optics'], follow: categoryFollow },
    { concepts: [{ displayName: 'Spatial transcriptomics' }], follow: queryFollow },
    { topics: [{ label: 'Spatial transcriptomics' }], follow: queryFollow },
    { keywords: ['Spatial transcriptomics'], follow: queryFollow },
  ];

  semanticPapers.forEach((paper, index) => {
    const score = scorePaperForRecommendation({ id: `semantic-${index}`, ...paper }, {
      now: NOW,
      followedEntities: [paper.follow],
    });
    assert.equal(score.followedEntityMatches.topic, true);
    assert.equal(score.followBoost, 35);
  });

  const titleOnly = scorePaperForRecommendation({
    id: 'title-only',
    title: 'Spatial transcriptomics maps tissue',
  }, { now: NOW, followedEntities: [queryFollow] });
  assert.equal(titleOnly.followedEntityMatches.topic, false);
});

test('weighted shuffle honors deterministic random selection', () => {
  const papers = [
    { id: 'low', _dynamicScore: 0, _type: 'exploration' },
    { id: 'high', _dynamicScore: 100, _type: 'exploit' },
  ];

  const shuffled = weightedShuffle(
    papers,
    mergeRecommendationWeights(),
    () => 0.99
  );

  assert.equal(shuffled[0].id, 'high');
  assert.deepEqual(new Set(shuffled.map((paper) => paper.id)), new Set(['low', 'high']));
});

test('diversified shuffle limits consecutive papers from the same category', () => {
  const papers = [
    { id: 'a1', primaryCategory: 'med.onco', _dynamicScore: 100 },
    { id: 'a2', primaryCategory: 'med.onco', _dynamicScore: 100 },
    { id: 'a3', primaryCategory: 'med.onco', _dynamicScore: 100 },
    { id: 'a4', primaryCategory: 'med.onco', _dynamicScore: 100 },
    { id: 'b1', primaryCategory: 'med.cardio', _dynamicScore: 1 },
  ];

  const shuffled = diversifiedWeightedShuffle(papers, { random: () => 0 });
  assert.deepEqual(
    shuffled.slice(0, 4).map(paper => paper.primaryCategory),
    ['med.onco', 'med.onco', 'med.onco', 'med.cardio']
  );
});

test('diversified shuffle recalculates scores from the evolving recent queue', () => {
  const observedCounts = [];
  const initialPapers = Array.from({ length: 4 }, (_, index) => ({
    id: `published-${index}`,
    primaryCategory: 'med.gen',
    publicationStatus: 'published',
  }));
  const papers = [
    { id: 'preprint', primaryCategory: 'med.onco', publicationStatus: 'preprint' },
    { id: 'published', primaryCategory: 'med.cardio', publicationStatus: 'published' },
  ];

  diversifiedWeightedShuffle(papers, {
    initialPapers,
    random: () => 0,
    scorePaper: (paper, recentPropsCount) => {
      observedCounts.push({ ...recentPropsCount });
      paper._dynamicScore = 1;
      paper._debugScore = {};
    },
  });

  assert.equal(observedCounts[0].published, 4);
  assert.ok(observedCounts.some(counts => counts.preprint > 0));
});

// A deterministic generator, so the budget below measures the algorithm and not
// the luck of a particular draw.
function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('the diversified shuffle does not re-score the whole pool on every iteration', () => {
  // The meter. `paperTopicSignals` reads `concepts` exactly once per full score
  // computation, so this getter counts how many times the expensive half of the
  // score actually ran -- which is the thing the budget is about. Counting the
  // injected callback instead would measure the shape of the shuffle's loop,
  // not its cost: the callback must keep being invoked per iteration so the
  // diversity boost still tracks the evolving recent queue.
  let signalPasses = 0;

  // A mix that makes the recent-window counts move: preprints and published,
  // open access and paywalled, journals and conferences. A uniform pool would
  // freeze the diversity boost and flatter the budget.
  const papers = Array.from({ length: 60 }, (_, index) => ({
    id: `budget-${index}`,
    primaryCategory: `cat.${index % 5}`,
    publicationStatus: index % 3 === 0 ? 'preprint' : 'published',
    openAccess: index % 2 === 0,
    sourceType: index % 4 === 0 ? 'conference' : 'journal',
    published: '2026-06-01T00:00:00Z',
    get concepts() {
      signalPasses += 1;
      return [];
    },
  }));

  // The production seam: FeedContext injects `applyRecommendationScore` bound to
  // a context it rebuilds on every call, with only `recentPropsCount` changing.
  const context = {
    followedEntities: [{ type: 'topic', canonicalId: 'T-quantum', displayName: 'Quantum optics' }],
    now: NOW,
  };
  const shuffled = diversifiedWeightedShuffle(papers, {
    random: seededRandom(7),
    scorePaper: (paper, recentPropsCount) => applyRecommendationScore(paper, { ...context, recentPropsCount }),
  });

  // Contract first: the shuffle still returns every paper exactly once.
  assert.equal(shuffled.length, papers.length);
  assert.deepEqual(new Set(shuffled.map(paper => paper.id)), new Set(papers.map(paper => paper.id)));

  // Budget: the expensive half is NFD normalisation and three regexes per
  // followed entity per candidate signal, plus eight arrays flattened and two
  // date parses. Re-running it for the whole pool on every iteration costs
  // N(N+1)/2 = 1830 passes here, and grows quadratically as the reader scrolls
  // and the pool fills. Nothing in that half depends on the recent window: the
  // only part of the score that moves with the iteration is the diversity
  // boost, six integer comparisons against five booleans. So the expensive half
  // is owed once per paper, hence a bound of 2N -- tight enough that restoring
  // the per-iteration pass fails it by an order of magnitude, loose enough not
  // to be brittle about how the cache is scoped.
  // Both ends, because a one-sided budget can go green for the wrong reason: if
  // a later refactor stops routing through `paper.concepts`, the meter reads 0
  // and a vacuous pass would hide the very quadratic this test exists to catch.
  assert.ok(signalPasses >= papers.length, `expensive half ran ${signalPasses} times, expected at least one pass per paper`);
  assert.ok(signalPasses <= papers.length * 2, `the expensive half of the score ran ${signalPasses} times`);
});

test('trims the shuffle pool to a scored head instead of walking hundreds of extras', () => {
  const papers = Array.from({ length: 120 }, (_, index) => ({
    id: `pool-${index}`,
    primaryCategory: 'cs.AI',
    _dynamicScore: index,
  }));
  const trimmed = trimScoredCandidatePool(papers, { cap: 10 });
  assert.equal(trimmed.length, 10);
  assert.equal(trimmed[0].id, 'pool-119');
  assert.equal(trimmed[9].id, 'pool-110');
  assert.equal(FEED_SHUFFLE_POOL_CAP, 80);

  const shuffled = diversifiedWeightedShuffle(papers, {
    poolCap: 12,
    random: () => 0,
  });
  assert.equal(shuffled.length, 12);
});
