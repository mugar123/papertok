import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecommendationScore,
  diversifiedWeightedShuffle,
  FEED_SHUFFLE_POOL_CAP,
  paperAffinitySignals,
  pickExplorationCategories,
  scorePaperForRecommendation,
  trimScoredCandidatePool,
} from './recommendationEngine.ts';
import {
  createEmptyInteractionProfile,
  readProfileSignals,
  recordInteractionEvent,
} from './interactionProfile.ts';

const NOW = new Date('2026-07-05T12:00:00Z').getTime();

test('selected user category dominates neutral papers', () => {
  const score = scorePaperForRecommendation(
    {
      id: 'paper-a',
      primaryCategory: 'cs.AI',
      allCategories: ['cs.AI'],
      published: '2026-07-05T00:00:00Z',
      authors: ['A. Researcher'],
      abstract: 'We study how selected categories shape the order of a reading feed.',
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

test('the selected categories give way to learned behaviour as interactions accumulate', () => {
  const paper = { id: 'paper-a', primaryCategory: 'cs.AI', published: '2026-07-05T00:00:00Z' };
  const preferenceAfter = (interactionCount: number) => scorePaperForRecommendation(paper, {
    now: NOW, userPreferences: ['cs.AI'], interactionCount,
  }).preference;

  assert.equal(preferenceAfter(0), 100);
  assert.equal(preferenceAfter(150), 50);
  assert.equal(preferenceAfter(5000), 30, 'never below a third of the original weight');
});

// A specialist source's card names no category of the taxonomy, only its own
// terms. Fetched for one of the reader's categories, it ranks as theirs, as
// it did when the mapper wrote that category onto the card.
test('a card fetched for one of the reader\'s categories keeps the preference without carrying it', () => {
  const paper = {
    id: 'pmid:42820985',
    primaryCategory: 'Nitrogen',
    categories: ['Nitrogen', 'Quantitative Trait Loci', 'Oryza'],
    _fetchedFor: ['bio.eco', 'bio.gen'],
    published: '2026-07-01T00:00:00Z',
  };
  const preference = (userPreferences: string[]) => scorePaperForRecommendation(paper, { now: NOW, userPreferences }).preference;

  assert.equal(preference(['bio.gen']), 100);
  assert.equal(preference(['bio.eco', 'cs.AI']), 100);
  assert.equal(preference(['bio.neuro']), 0, 'fetched for categories the reader did not choose');
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

  // A concept OpenAlex gave no score counts in full, as it does when learned.
  const unscored = scorePaperForRecommendation(
    { id: 'paper-b', primaryCategory: 'cs.CL', openAlex: { concepts: [{ id: 'concept-1' }] } },
    { now: NOW, conceptAffinities: { 'concept-1': 50 } },
  );
  assert.equal(unscored.semantic, 25);
});

test('category signals preserve personalization without OpenAlex enrichment', () => {
  const paper = {
    id: 'paper-local',
    primaryCategory: 'physics.optics',
    allCategories: ['physics.optics', 'quant-ph'],
    published: '2026-07-01T00:00:00Z',
  };

  const score = scorePaperForRecommendation(paper, {
    now: NOW,
    userPreferences: ['quant-ph'],
    categoryAffinities: { 'physics.optics': 10, 'quant-ph': 10 },
  });

  assert.equal(score.semantic, 0);
  assert.equal(score.preference, 80);
  // The primary category in full, a secondary one at 0.35.
  assert.equal(score.affinity, 13.5);
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
  assert.equal(score.semantic, 50);
  assert.equal(score.citations, 25);
  assert.ok(score.classicBoost <= 25);

  const learned = scorePaperForRecommendation({
    id: 'paper-learned',
    primaryCategory: 'cs.AI',
    authors: Array.from({ length: 10 }, (_, index) => ({ name: `Author ${index}`, id: `https://openalex.org/A${index}` })),
    openAlex: { concepts: extremeConcepts },
  }, {
    now: NOW,
    authorAffinities: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`A${index}`, 100])),
    sessionAffinities: { 'cs.AI': 1000, ...Object.fromEntries(extremeConcepts.map(concept => [concept.id, 1000])) },
  });
  assert.equal(learned.learnedAuthor, 30);
  assert.equal(learned.sessionInterest, 30);
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
  assert.ok(score.semantic >= -50);
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
      { type: 'topic' as const, canonicalId: 'physics.optics', displayName: 'Optics' },
      { type: 'institution', canonicalId: 'I2', displayName: 'Institute' },
      { type: 'project', canonicalId: 'project-3', displayName: 'Project' },
    ],
  });

  assert.equal(score.followBoost, 70);
  assert.deepEqual(score.followedEntityMatches, { author: true, topic: true, institution: true, project: true });
});

test('matches followed topics directly across categories, concepts, topics, and keywords', () => {
  const queryFollow = {
    type: 'topic' as const,
    canonicalId: 'query-1234abcd',
    displayName: 'Transcriptómica espacial',
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'pubmed',
      categoryIds: [],
    },
  };
  const categoryFollow = {
    type: 'topic' as const,
    canonicalId: 'query-8765abcd',
    displayName: 'Optics',
    metadata: { query: 'Photonics', categoryIds: ['physics.optics'] },
  };
  const semanticPapers = [
    { categories: ['physics.optics'], follow: categoryFollow },
    { concepts: [({ displayName: 'Spatial transcriptomics' } as import('../models/Paper.ts').PaperSubject & { displayName: string })], follow: queryFollow },
    { topics: [({ label: 'Spatial transcriptomics' } as import('../models/Paper.ts').PaperSubject & { label: string })], follow: queryFollow },
    { keywords: [('Spatial transcriptomics' as string & import('../models/Paper.ts').PaperSubject)], follow: queryFollow },
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

test('learned authors count only by their OpenAlex id', () => {
  const score = (authors: Array<{ name: string; id?: string }>) => scorePaperForRecommendation(
    { id: 'paper-authors', primaryCategory: 'cs.AI', authors },
    { now: NOW, authorAffinities: { A42: 10 } },
  ).learnedAuthor;

  assert.equal(score([{ name: 'Ada', id: 'https://openalex.org/A42' }]), 12);
  assert.equal(score([{ name: 'Ada' }]), 0, 'a name alone is not an identity');
  assert.equal(score([{ name: 'Ada', id: '1741101' }]), 0, 'another provider\'s author id is not this one');
});

test('the session lifts what the reader has just engaged with and sinks what they keep skipping', () => {
  const paper = {
    id: 'paper-session',
    primaryCategory: 'cs.AI',
    openAlex: { concepts: [{ id: 'https://openalex.org/C1', display_name: 'Diffusion', score: 0.5 }] },
  };
  const engaged = scorePaperForRecommendation(paper, { now: NOW, sessionAffinities: { 'cs.AI': 5, C1: 5 } });
  const skipped = scorePaperForRecommendation(paper, { now: NOW, sessionAffinities: { 'cs.AI': -3 } });

  // (5 + 0.5 * 5) / 15 of the 30-point ceiling.
  assert.equal(engaged.sessionInterest, 15);
  assert.equal(skipped.sessionInterest, -6);
});

test('a paper recommended for the reader\'s own examples is boosted', () => {
  const abstract = 'A recommended paper with an abstract the card can show.';
  const plain = scorePaperForRecommendation({ id: 'plain', primaryCategory: 'cs.AI', abstract }, { now: NOW });
  const personal = scorePaperForRecommendation({ id: 'personal', primaryCategory: 'cs.AI', abstract, _isPersonalCandidate: true }, { now: NOW });

  assert.equal(plain.personalBoost, 0);
  assert.equal(personal.personalBoost, 20);
  assert.equal(personal.total - plain.total, 20);
});

test('a card without an abstract ranks below the same card with one', () => {
  const paper = { primaryCategory: 'cs.AI', published: '2026-07-01T00:00:00Z' };
  const context = { now: NOW, userPreferences: ['cs.AI'] };
  const withAbstract = scorePaperForRecommendation({ ...paper, id: 'with', abstract: 'We measure what a feed card needs to be read.' }, context);
  // The OpenAlex mapper's placeholder is what a missing abstract looks like in the feed.
  const placeholder = scorePaperForRecommendation({ ...paper, id: 'placeholder', abstract: 'No abstract available.' }, context);
  const empty = scorePaperForRecommendation({ ...paper, id: 'empty', abstract: '' }, context);

  assert.ok(placeholder.total < withAbstract.total);
  assert.equal(empty.total, placeholder.total);
  assert.match(placeholder.explanation, /missingAbstract/);
});

test('a paper lends the profile its OpenAlex concepts and first ten OpenAlex authors', () => {
  const signals = paperAffinitySignals({
    authors: [
      { name: 'Named only' },
      ...Array.from({ length: 12 }, (_, index) => ({ name: `Author ${index}`, id: `https://openalex.org/a${index}` })),
    ],
    openAlex: { concepts: [{ id: 'https://openalex.org/C41008148', display_name: 'Computer science', score: 0.7 }] },
  });

  assert.deepEqual(signals.concepts, [{ id: 'C41008148', score: 0.7 }]);
  assert.deepEqual(signals.authorIds, Array.from({ length: 9 }, (_, index) => `A${index}`));
});

test('exploration keeps offering what holds the reader, still tries the unseen and drops what they skip', () => {
  const random = seededRandom(11);
  const exposure = {
    'q-fin.GN': { shown: 40, engaged: 30 },
    'q-fin.RM': { shown: 40, engaged: 1 },
  };
  const picks: Record<string, number> = { 'q-fin.GN': 0, 'q-fin.RM': 0, 'q-fin.ST': 0 };
  const draws = 2000;
  for (let index = 0; index < draws; index += 1) {
    picks[pickExplorationCategories(['q-fin.GN', 'q-fin.RM', 'q-fin.ST'], exposure, 1, random)[0]] += 1;
  }

  assert.ok(picks['q-fin.GN'] / draws > 0.6, `engaging category drawn ${picks['q-fin.GN']} times`);
  assert.ok(picks['q-fin.ST'] / draws > 0.1, `unseen category drawn ${picks['q-fin.ST']} times`);
  assert.ok(picks['q-fin.RM'] / draws < 0.02, `skipped category drawn ${picks['q-fin.RM']} times`);
  assert.deepEqual(pickExplorationCategories(['a', 'b', 'c', 'd'], {}, 3, random).length, 3);
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
  const observedCounts: Record<string, number>[] = [];
  const initialPapers = Array.from({ length: 4 }, (_, index) => ({
    id: `published-${index}`,
    primaryCategory: 'med.gen',
    publicationStatus: 'published' as const,
  }));
  const papers = [
    { id: 'preprint', primaryCategory: 'med.onco', publicationStatus: 'preprint' as const },
    { id: 'published', primaryCategory: 'med.cardio', publicationStatus: 'published' as const },
  ];

  diversifiedWeightedShuffle(papers, {
    initialPapers,
    random: () => 0,
    scorePaper: (paper, recentPropsCount) => {
      observedCounts.push({ ...recentPropsCount });
      (paper as Partial<import('../models/Paper.ts').Paper>)._dynamicScore = 1;
      (paper as Partial<import('../models/Paper.ts').Paper>)._debugScore = {};
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
    publicationStatus: index % 3 === 0 ? 'preprint' as const : 'published' as const,
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
    followedEntities: [{ type: 'topic' as const, canonicalId: 'T-quantum', displayName: 'Quantum optics' }],
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


// Cards written for these tests (synthetic, not captured from a provider).
// Every card is filed under cs.LG; what tells the two groups apart is only the
// OpenAlex topic each card carries itself, as an OpenAlex card does on arrival.
const RL_TOPIC = { id: 'https://openalex.org/T900001', display_name: 'Reinforcement learning', score: 0.95 };
const VISION_TOPIC = { id: 'https://openalex.org/T900002', display_name: 'Computer vision', score: 0.95 };
const makeCard = (id: string, primaryTopic: typeof RL_TOPIC) => ({
  id,
  title: `Paper ${id}`,
  abstract: `A synthetic abstract for paper ${id}, long enough to count as one.`,
  primaryCategory: 'cs.LG',
  published: '2026-07-01T00:00:00Z',
  primaryTopic,
});
const rlPool = ['rl-1', 'rl-2', 'rl-3', 'rl-4', 'rl-5', 'rl-6'].map(id => makeCard(id, RL_TOPIC));
const visionPool = ['cv-1', 'cv-2', 'cv-3', 'cv-4', 'cv-5', 'cv-6'].map(id => makeCard(id, VISION_TOPIC));

/** What the feed does on a like: the interaction profile learns it, the ranking reads it back. */
function readerWhoLiked(liked: Array<Parameters<typeof paperAffinitySignals>[0] & { id: string; primaryCategory: string }>) {
  const profile = createEmptyInteractionProfile();
  liked.forEach(card => recordInteractionEvent(profile, {
    paperId: card.id, kind: 'like', category: card.primaryCategory, timestamp: NOW, ...paperAffinitySignals(card),
  }, NOW));
  const signals = readProfileSignals(profile, NOW);
  return {
    now: NOW,
    userPreferences: ['cs.LG'],
    categoryAffinities: signals.categoryAffinities,
    conceptAffinities: signals.conceptAffinities,
    authorAffinities: signals.authorAffinities,
    interactionCount: signals.interactionCount,
  };
}

/** The ids a reader's feed would take first from the same pool. */
function topIds(pool: ReturnType<typeof makeCard>[], context: ReturnType<typeof readerWhoLiked>, take: number) {
  // Fresh copies: scoring writes onto the cards it scores.
  return trimScoredCandidatePool(pool.map(card => ({ ...card })), {
    cap: take,
    scorePaper: (paper, recentPropsCount) => applyRecommendationScore(paper, { ...context, recentPropsCount }),
  }).map(paper => paper.id).sort();
}

test('a concept or topic the card carries itself counts like one under openAlex, once', () => {
  const card = {
    id: 'carried',
    primaryCategory: 'cs.LG',
    published: '2026-07-05T00:00:00Z',
    abstract: 'We study how learned concepts reach the ranking from the card itself.',
    concepts: [{ id: 'https://openalex.org/C154945302', display_name: 'Artificial intelligence', level: 1, score: 0.8 }],
    primaryTopic: { id: 'https://openalex.org/T10320', display_name: 'Neural Networks and Applications', score: 0.9 },
    openAlex: { concepts: [{ id: 'https://openalex.org/C154945302', score: 0.8 }] },
  };

  assert.deepEqual(paperAffinitySignals(card).concepts, [
    { id: 'C154945302', score: 0.8 },
    { id: 'T10320', score: 0.9 },
  ]);

  const learned = { now: NOW, conceptAffinities: { C154945302: 50, T10320: 20 } };
  const score = scorePaperForRecommendation(card, learned);
  // 0.8 * 0.5 + 0.9 * 0.2 of the semantic ceiling; a double count of the
  // concept listed in both places would give 0.8 * 1.0 + 0.18.
  assert.ok(Math.abs(score.semantic - (0.8 * 0.5 + 0.9 * 0.2) * 50) < 1e-9, `semantic ${score.semantic}`);
});

test('the keyword ids a provider makes up for one card teach the reader no concept', () => {
  // Shaped like europePmcService (`epmc:<pmid>:<index>`) and the bioRxiv
  // collection of domainSourceService; the PMIDs are made up.
  const bioRxivCard = (id: string) => ({
    id, primaryCategory: 'q-bio.NC', published: '2026-07-01T00:00:00Z',
    concepts: [{ id: 'biorxiv:neuroscience', display_name: 'Neuroscience', level: 2 }],
  });
  const europePmcCard = {
    id: 'pubmed:1000001', primaryCategory: 'q-bio.NC', published: '2026-07-01T00:00:00Z',
    concepts: [
      { id: 'epmc:1000001:0', display_name: 'Neurons', level: 2 },
      { id: 'epmc:1000001:1', display_name: 'Hippocampus', level: 2 },
    ],
    primaryTopic: { id: 'https://openalex.org/T900003', display_name: 'Memory consolidation', score: 0.9 },
  };

  const reader = readerWhoLiked([bioRxivCard('biorxiv:1'), bioRxivCard('biorxiv:2'), europePmcCard]);

  assert.deepEqual(Object.keys(reader.conceptAffinities), ['T900003']);
  assert.equal(scorePaperForRecommendation(bioRxivCard('biorxiv:3'), reader).semantic, 0);
});

test('two readers who picked the same category and liked different papers get different papers first from the same pool', () => {
  const pool = [...rlPool.slice(3), ...visionPool.slice(3)];
  const likedRl = readerWhoLiked(rlPool.slice(0, 3));
  const likedVision = readerWhoLiked(visionPool.slice(0, 3));

  assert.deepEqual(topIds(pool, likedRl, 3), ['rl-4', 'rl-5', 'rl-6']);
  assert.deepEqual(topIds(pool, likedVision, 3), ['cv-4', 'cv-5', 'cv-6']);
});

test('a reader who has liked nothing yet ranks the cards as if they carried no topic', () => {
  const pool = [...rlPool, ...visionPool];
  const cold = readerWhoLiked([]);
  const scoresOf = (cards: Array<Partial<ReturnType<typeof makeCard>>>) => cards.map(card => scorePaperForRecommendation(card, cold).total);

  assert.deepEqual(scoresOf(pool), scoresOf(pool.map(card => ({ ...card, primaryTopic: undefined }))));
});
