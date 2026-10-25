import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecommendationScore,
  diversifiedWeightedShuffle,
  FEED_SHUFFLE_POOL_CAP,
  nearbyExplorationCategories,
  paperAffinitySignals,
  pickExplorationCategories,
  scorePaperForRecommendation,
  trimScoredCandidatePool,
} from './recommendation-engine.ts';
import type { Paper } from '../models/paper.ts';
import type { OpenAlexWork } from '../services/adapters/open-alex-types.ts';
import { readFileSync } from 'node:fs';
import { mapOpenAlexWork } from './open-alex-work.ts';
import type { RecommendationContext } from './recommendation-engine.ts';
import { dormantCategories } from './interest-memory.ts';
import { getAllLeafCategories } from '../data/category-taxonomy.ts';
import {
  createEmptyInteractionProfile,
  readProfileSignals,
  recordInteractionEvent,
  serializeInteractionProfile,
} from './interaction-profile.ts';

const NOW = new Date('2026-07-05T12:00:00Z').getTime();
const leavesOf = (area: string) => getAllLeafCategories().filter(leaf => leaf.area === area).map(leaf => leaf.id);

// The preference share is a product of floats: 1 - 1 * 0.7 is not exactly 0.3.
const assertClose = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? 'expected'} ${expected}, got ${actual}`);

test('corpus semantics affect the client score independently and stay bounded', () => {
  const score = (value?: number) => scorePaperForRecommendation({ id: 'candidate', _semanticScore: value }, { now: NOW });
  const neutral = score();
  assert.equal(neutral.corpusSimilarity, 0);
  assert.equal(score(0.8).total - neutral.total, 80);
  assert.equal(score(-0.5).corpusSimilarity, -50);
  assert.ok(Math.abs(score(-0.5).total - neutral.total + 50) < 1e-10);
  assert.equal(score(2).corpusSimilarity, 100);
  assert.equal(score(-2).corpusSimilarity, -100);
  assert.equal(score(NaN).total, neutral.total);
});

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

// ENG-137, ruling R13: an established pick (made at onboarding, or learned)
// gives way as the reader's interactions accumulate, as it always did.
test('an established pick gives way to learned behaviour as interactions accumulate', () => {
  const paper = { id: 'paper-a', primaryCategory: 'cs.AI', published: '2026-07-05T00:00:00Z' };
  const preferenceAfter = (interactionCount: number) => scorePaperForRecommendation(paper, {
    now: NOW, userPreferences: ['cs.AI'], interestProgress: { 'cs.AI': 0 }, coldAdded: [], interactionCount,
  }).preference;

  assert.equal(preferenceAfter(0), 100);
  assertClose(preferenceAfter(210), 30);
  assert.equal(preferenceAfter(5000), 30, 'never below a third of the original weight');
});

// An interest the reader added weighs by how much the app has learned of that
// subarea or area, not by how many cards the reader has touched in all.
test('an added interest weighs fully while new and gives way as the app learns it', () => {
  const paper = { id: 'paper-a', primaryCategory: 'econ.EM', published: '2026-07-05T00:00:00Z' };
  const preferenceAt = (progress: number) => scorePaperForRecommendation(paper, {
    now: NOW, userPreferences: ['econ.EM'], interestProgress: { 'econ.EM': progress }, coldAdded: ['econ.EM'], interactionCount: 5000,
  }).preference;

  assert.equal(preferenceAt(0), 100);
  assertClose(preferenceAt(0.5), 65);
  assertClose(preferenceAt(1), 30, 'never below a third of the original weight');
});

test('a card weighs by the most-learned added subarea it matches, however it matches', () => {
  const progress = { 'econ.EM': 1, 'econ.GN': 0 };
  const preference = (paper: Parameters<typeof scorePaperForRecommendation>[0]) => scorePaperForRecommendation(
    { published: '2026-07-05T00:00:00Z', ...paper },
    { now: NOW, userPreferences: ['econ.EM', 'econ.GN'], interestProgress: progress, coldAdded: ['econ.EM', 'econ.GN'] },
  ).preference;

  assertClose(preference({ id: 'a', primaryCategory: 'econ.EM' }), 30);
  assert.equal(preference({ id: 'b', primaryCategory: 'econ.GN' }), 100);
  assertClose(preference({ id: 'c', primaryCategory: 'econ.EM', allCategories: ['econ.EM', 'econ.GN'] }), 30, 'the primary category decides when it is picked');
  assertClose(preference({ id: 'd', primaryCategory: 'math.ST', allCategories: ['math.ST', 'econ.EM', 'econ.GN'] }), 24, 'a cross-list is related, and weighs by the most-learned subarea it names');
  assertClose(preference({ id: 'e', primaryCategory: 'Nitrogen', _fetchedFor: ['econ.EM'] }), 30, 'a card fetched for a pick weighs as that pick');
  assert.equal(preference({ id: 'f', primaryCategory: 'math.ST' }), 0);
});

// ENG-137, ruling R17: a card cross-listed or fetched under an established
// pick and an added one weighs as the pick its primary category matches.
test('a card that matches an established pick and an added one weighs as the pick its primary category matches', () => {
  const published = '2026-07-05T00:00:00Z';
  const preference = (paper: Parameters<typeof scorePaperForRecommendation>[0], coldAdded: string[], interactionCount: number) =>
    scorePaperForRecommendation({ published, ...paper }, {
      now: NOW,
      userPreferences: ['cs.LG', 'cs.RO', 'bio.gen', 'bio.mol'],
      interestProgress: { 'cs.LG': 1, 'cs.RO': 0, 'bio.gen': 1, 'bio.mol': 0 },
      coldAdded,
      interactionCount,
    }).preference;
  const crossListed = { allCategories: ['cs.RO', 'cs.LG'], _fetchedFor: ['cs.LG', 'cs.RO'] };
  const robotics = { id: 'ro', primaryCategory: 'cs.RO', ...crossListed };
  const learning = { id: 'lg', primaryCategory: 'cs.LG', ...crossListed };
  // OpenAlex files it under a topic bio.mol lists; it was fetched for bio.gen.
  const rna = { id: 'rna', primaryTopic: { id: 'https://openalex.org/T10604', display_name: 'RNA Research and Splicing' }, _fetchedFor: ['bio.gen'] };

  assert.equal(preference(robotics, ['cs.RO', 'bio.mol'], 210), 100);
  assertClose(preference(learning, ['cs.RO', 'bio.mol'], 210), 30);
  assert.equal(preference(rna, ['cs.RO', 'bio.mol'], 210), 100);

  // With no edits, every pick fades with the reader's interactions, as on main.
  for (const paper of [robotics, learning, rna]) {
    assert.equal(preference(paper, [], 0), 100);
    assertClose(preference(paper, [], 150), 50);
    assertClose(preference(paper, [], 210), 30);
  }
});

// ENG-137: a subject the reader left keeps its examples and affinities, but
// they must not rank anything.
test('learned signals score nothing in a subarea the reader removed, follows still do', () => {
  const hepTh = {
    id: 'hep-th-1',
    primaryCategory: 'hep-th',
    published: '2026-07-05T00:00:00Z',
    authors: [{ id: 'https://openalex.org/A1', name: 'A. Physicist' }],
    openAlex: { concepts: [{ id: 'C42', score: 1 }] },
    _semanticScore: 0.6,
  };
  const physicsFollow = { type: 'topic' as const, canonicalId: 'hep-th', displayName: 'High energy physics theory' };
  const context = {
    now: NOW,
    userPreferences: ['econ.EM'],
    interestProgress: { 'econ.EM': 0 },
    categoryAffinities: { 'hep-th': 80 },
    conceptAffinities: { C42: 80 },
    authorAffinities: { A1: 40 },
    sessionAffinities: { 'hep-th': 40, C42: 40 },
    followedEntities: [physicsFollow],
  };

  const dormant = scorePaperForRecommendation(hepTh, { ...context, dormantCategories: dormantCategories(['econ.EM'], ['hep-th']) });
  assert.deepEqual(
    [dormant.affinity, dormant.semantic, dormant.corpusSimilarity, dormant.learnedAuthor, dormant.sessionInterest],
    [0, 0, 0, 0, 0],
  );
  assert.equal(dormant.followBoost, 35);

  const active = scorePaperForRecommendation(hepTh, { ...context, dormantCategories: dormantCategories(['econ.EM', 'hep-th'], []) });
  assert.equal(active.affinity, 80);
  assert.equal(active.semantic, 40);
  assert.equal(active.corpusSimilarity, 60);
  assert.equal(active.learnedAuthor, 30);
  assert.equal(active.sessionInterest, 30);
  assert.equal(active.followBoost, 35);

  // Without a list of what the reader removed nothing is dormant: scoring as before.
  assert.equal(scorePaperForRecommendation(hepTh, context).affinity, 80);
});

// A card that names no leaf of its own is still the reader's unless its area,
// its topic or the request that fetched it says the reader removed it.
test('cards that name no leaf stay active unless their area, topic or request was removed', () => {
  const published = '2026-07-05T00:00:00Z';
  const context = {
    now: NOW,
    userPreferences: ['econ.EM'],
    dormantCategories: dormantCategories(['econ.EM'], ['quant-ph', 'hep-th']),
    categoryAffinities: { econ: 60, Nitrogen: 60, 'econ.GN': 60 },
    sessionAffinities: { Nitrogen: 40 },
  };
  const score = (paper: Parameters<typeof scorePaperForRecommendation>[0]) =>
    scorePaperForRecommendation({ published, _semanticScore: 0.5, ...paper }, context);

  // A working paper is filed under its area, with no leaf and nothing fetched for.
  const workingPaper = score({ id: 'wp', primaryCategory: 'econ' });
  assert.equal(workingPaper.corpusSimilarity, 50);
  assert.equal(workingPaper.affinity, 60);

  // An area-lane article has no category of the taxonomy, only the request that fetched it.
  assert.equal(score({ id: 'lane', primaryCategory: '', categories: ['Panel data'], _type: 'exploit' }).corpusSimilarity, 50);

  // A card fetched for a nearby leaf the reader did not pick.
  const nearby = score({ id: 'nearby', primaryCategory: 'Nitrogen', _fetchedFor: ['econ.GN'] });
  assert.equal(nearby.corpusSimilarity, 50);
  assert.equal(nearby.sessionInterest, 30);

  // The same shapes in an area the reader left stay dormant.
  assert.equal(score({ id: 'other-wp', primaryCategory: 'physics' }).corpusSimilarity, 0);
  assert.equal(score({ id: 'other-fetched', primaryCategory: 'Nitrogen', _fetchedFor: ['hep-th'] }).sessionInterest, 0);
});

// ENG-137, rulings R12 and R18: only evidence of what the reader removed makes
// a card dormant. A card that says nothing of its area keeps its signals.
test('a card is dormant only when every piece of area evidence it carries was removed', () => {
  const published = '2026-07-05T00:00:00Z';
  const context = {
    now: NOW,
    userPreferences: ['econ.EM'],
    dormantCategories: dormantCategories(['econ.EM'], ['hep-th']),
  };
  const similarity = (paper: Parameters<typeof scorePaperForRecommendation>[0], dormant = context.dormantCategories) =>
    scorePaperForRecommendation({ published, _semanticScore: 0.5, ...paper }, { ...context, dormantCategories: dormant }).corpusSimilarity;

  // A followed author's journal article: concept names, a topic no leaf lists, no request it was fetched for.
  const article = {
    id: 'followed-article',
    primaryCategory: '',
    categories: ['Panel data', 'Econometrics'],
    primaryTopic: { id: 'https://openalex.org/T900003', display_name: 'Memory consolidation' },
    _type: 'followed' as const,
  };
  assert.equal(similarity(article), 50);

  // A primary topic that one leaf (bio.mol) lists: awake unless the reader removed that leaf.
  const rna = { id: 'rna', categories: ['Biology', 'Genetics'], primaryTopic: { id: 'https://openalex.org/T10604', display_name: 'RNA Research and Splicing' }, _type: 'followed' as const };
  assert.equal(similarity(rna), 50);
  assert.equal(similarity(rna, dormantCategories(['econ.EM'], ['bio.mol'])), 0);
  // Fetched for a leaf the reader keeps as well: not every piece sleeps.
  assert.equal(similarity({ ...rna, _fetchedFor: ['bio.gen'] }, dormantCategories(['econ.EM', 'bio.gen'], ['bio.mol'])), 50);

  // A leaf the reader removed, and nothing else.
  assert.equal(similarity({ id: 'hep-th-1', primaryCategory: 'hep-th', _type: 'followed' }), 0);
});

// ENG-137, rulings R16 and R18: an arXiv category the taxonomy has no leaf
// for (math.AC, cond-mat.dis-nn, hep-lat) belongs to its archive's area, and
// sleeps only when the reader removed a subarea of that area and kept none.
test('a category with no leaf of its own sleeps only with an area the reader left', () => {
  const published = '2026-07-05T00:00:00Z';
  const score = (paper: Parameters<typeof scorePaperForRecommendation>[0], selected: string[], deselected: string[] = []) => scorePaperForRecommendation(
    { published, _semanticScore: 0.5, _type: 'followed', ...paper },
    {
      now: NOW,
      userPreferences: selected,
      dormantCategories: dormantCategories(selected, deselected),
      categoryAffinities: { 'math.AC': 40, 'cond-mat.dis-nn': 40, 'hep-lat': 40 },
    },
  );

  // A followed author's commutative algebra, for a reader of algebraic geometry and number theory.
  const commutativeAlgebra = score({ id: 'ac', primaryCategory: 'math.AC' }, ['math.AG', 'math.NT']);
  assert.deepEqual([commutativeAlgebra.corpusSimilarity, commutativeAlgebra.affinity], [50, 40]);

  // A Physics subarea removed and another kept: the area is still the reader's.
  const disorderedSystems = score({ id: 'dis-nn', primaryCategory: 'cond-mat.dis-nn' }, ['quant-ph'], ['hep-th']);
  assert.deepEqual([disorderedSystems.corpusSimilarity, disorderedSystems.affinity], [50, 40]);

  // Physics left: its removed subarea and the categories it has no leaf for sleep.
  assert.equal(score({ id: 'hep-th', primaryCategory: 'hep-th' }, ['math.AG'], ['hep-th']).corpusSimilarity, 0);
  const lattice = score({ id: 'hep-lat', primaryCategory: 'hep-lat' }, ['math.AG'], ['hep-th']);
  assert.deepEqual([lattice.corpusSimilarity, lattice.affinity], [0, 0]);
});

// ENG-137 (I-B): a card cross-listed in a subarea the reader removed and in
// one they never picked is awake, but the removed subarea's affinity is not
// counted on it.
test("a removed subarea's affinity scores nothing on an awake card cross-listed in it", () => {
  const card = { id: 'cross', primaryCategory: 'hep-th', allCategories: ['hep-th', 'gr-qc'], published: '2026-07-05T00:00:00Z', _semanticScore: 0.5, _type: 'followed' as const };
  const score = (dormant: string[]) => scorePaperForRecommendation(card, {
    now: NOW, userPreferences: ['econ.EM'], categoryAffinities: { 'hep-th': 80, 'gr-qc': 20 }, dormantCategories: dormant,
  });

  const removed = score(dormantCategories(['econ.EM'], ['hep-th']));
  assertClose(removed.affinity, 0.35 * 20, 'only gr-qc, as a secondary category:');
  assert.equal(removed.corpusSimilarity, 50);
  assertClose(score([]).affinity, 80 + 0.35 * 20);
});

// ENG-137 (M-3): a card that names no area but the one OpenAlex files it
// under (all of Chemistry's area-lane articles) sleeps by the area its
// learning counts under (areaKeyForPaper).
test('a card known only by its OpenAlex field sleeps when the reader removed all of that area', () => {
  const { sample } = JSON.parse(readFileSync(new URL('./open-alex-works.fixture.json', import.meta.url), 'utf8')) as { sample: OpenAlexWork[] };
  const work = sample.find(candidate => String(candidate.primary_topic?.field?.id).split('/').pop() === '16')!;
  const card = { ...mapOpenAlexWork(work)!, primaryCategory: '', _semanticScore: 0.5, _type: 'followed' as const };
  const similarity = (selected: string[], deselected: string[]) => scorePaperForRecommendation(card, {
    now: NOW, userPreferences: selected, dormantCategories: dormantCategories(selected, deselected),
  }).corpusSimilarity;

  assert.equal(similarity(['cs.LG'], leavesOf('chem')), 0);
  assert.equal(similarity(['cs.LG'], ['hep-th']), 50, 'a reader who never selected Chemistry');
  assert.equal(similarity(['cs.LG', 'chem.org'], ['chem.anal']), 50, 'a reader who keeps a Chemistry subarea');
});

// The feed's context is rebuilt on every call, and one re-rank's cache
// validates it by the references it holds, so memory that changes after the
// first pass must not be read back as the old one.
const RERANKED_CARDS = 3;
function lastCardOfRerank(category: string, memoryOnPass: (pass: 'first' | 'later') => Pick<RecommendationContext, 'interestProgress' | 'dormantCategories' | 'coldAdded' | 'interactionCount'>) {
  const cards = Array.from({ length: RERANKED_CARDS }, (_, index): Partial<Paper> => ({ id: `card-${index}`, primaryCategory: category, published: '2026-07-05T00:00:00Z' }));
  const userPreferences = ['econ.EM'];
  const categoryAffinities = { [category]: 50 };
  const first = memoryOnPass('first');
  const later = memoryOnPass('later');
  let scored = 0;
  return diversifiedWeightedShuffle(cards, {
    maxConsecutiveCategory: 10,
    random: () => 0,
    scorePaper: (paper, recentPropsCount) => applyRecommendationScore(paper, {
      now: NOW, userPreferences, categoryAffinities, recentPropsCount, ...(scored++ < RERANKED_CARDS ? first : later),
    }),
  }).at(-1)!._debugScore!;
}

test('a re-rank scores with the progress it holds now, not the one an earlier call cached', () => {
  const memory = {
    first: { interestProgress: { 'econ.EM': 0 }, coldAdded: ['econ.EM'] },
    later: { interestProgress: { 'econ.EM': 1 }, coldAdded: ['econ.EM'] },
  };
  assertClose(lastCardOfRerank('econ.EM', pass => memory[pass]).preference!, 30);
});

test('a re-rank scores with the cold-added picks it holds now, not the ones an earlier call cached', () => {
  const progress = { 'econ.EM': 0 };
  const memory = {
    first: { interestProgress: progress, coldAdded: ['econ.EM'], interactionCount: 300 },
    later: { interestProgress: progress, coldAdded: [], interactionCount: 300 },
  };
  assertClose(lastCardOfRerank('econ.EM', pass => memory[pass]).preference!, 30);
});

test('a re-rank scores with the interaction count it holds now, not the one an earlier call cached', () => {
  const memory = {
    first: { interactionCount: 0 },
    later: { interactionCount: 300 },
  };
  assertClose(lastCardOfRerank('econ.EM', pass => memory[pass]).preference!, 30);
});

test('a re-rank scores with the removed subareas it holds now, not the ones an earlier call cached', () => {
  const memory = {
    first: { dormantCategories: [] },
    later: { dormantCategories: dormantCategories(['econ.EM'], ['hep-th']) },
  };
  assert.equal(lastCardOfRerank('hep-th', pass => memory[pass]).affinity, 0);
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
      citationCount: 99,
      openAlex: {
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

// Plan A and F1 (PAP-73): OpenAlex files a work under its own topic, never under
// a leaf of the taxonomy. A primary topic among a chosen leaf's measured topics
// is evidence for that leaf, read when ranking and never stored.
test("an OpenAlex card earns a chosen leaf's preference when that leaf lists its primary topic", () => {
  const card = {
    id: 'openalex:W7222916812',
    categories: ['Biology', 'Genetics'],
    primaryTopic: { id: 'https://openalex.org/T10604', display_name: 'RNA Research and Splicing' },
  };
  const preferenceFor = (userPreferences: string[], paper: typeof card = card) => (
    scorePaperForRecommendation(paper, { now: NOW, userPreferences }).preference
  );

  assert.equal(preferenceFor(['cs.LG', 'bio.mol']), 100);
  assert.equal(preferenceFor(['bio.eco', 'cs.LG']), 0, "another leaf's reader");
  const satellite = { ...card, primaryTopic: { id: 'https://openalex.org/T12042', display_name: 'Satellite Communication Systems' } };
  assert.equal(preferenceFor(['mech.aero'], satellite), 0, 'a topic no chosen leaf lists');
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
      citationCount: 5_000_000,
      openAlex: { concepts: extremeConcepts },
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

test('the citation term reads the paper\'s own count, not the OpenAlex payload\'s', () => {
  const profile = { now: NOW, categoryAffinities: {}, conceptAffinities: {}, temporalPreference: -1 };
  const base = { id: 'paper-cited', primaryCategory: 'cs.AI', published: '2020-01-01T00:00:00Z', citationCount: 500, openAlex: { citationCount: 0 } };
  const withPayload = scorePaperForRecommendation(base, profile);
  const without = scorePaperForRecommendation({ ...base, openAlex: undefined }, profile);
  assert.equal(withPayload.citations, without.citations);
  assert.equal(withPayload.classicBoost, without.classicBoost);
  assert.ok(withPayload.classicBoost > 0);
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
    { concepts: [({ displayName: 'Spatial transcriptomics' } as import('../models/paper.ts').PaperSubject & { displayName: string })], follow: queryFollow },
    { topics: [({ label: 'Spatial transcriptomics' } as import('../models/paper.ts').PaperSubject & { label: string })], follow: queryFollow },
    { keywords: [('Spatial transcriptomics' as string & import('../models/paper.ts').PaperSubject)], follow: queryFollow },
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

test('exploration for an AI reader stays within AI, and a CS reader explores no AI', () => {
  assert.deepEqual(nearbyExplorationCategories(['cs.LG']), ['cs.AI', 'cs.CV', 'cs.CL', 'cs.NE']);
  assert.deepEqual(nearbyExplorationCategories(['cs.AI', 'cs.LG', 'cs.CV', 'cs.CL', 'cs.NE']), []);
  assert.deepEqual(nearbyExplorationCategories(['cs.LG'], { 'cs.CV': -3 }), ['cs.AI', 'cs.CL', 'cs.NE']);
  assert.deepEqual(nearbyExplorationCategories(['cs.RO']).filter(id => ['cs.AI', 'cs.LG', 'cs.CV', 'cs.CL', 'cs.NE'].includes(id)), []);
  assert.ok(nearbyExplorationCategories(['cs.RO']).includes('cs.CR'));
});

test('exploration never reaches an area the reader did not pick, removals or not', () => {
  const ai = leavesOf('ai');
  assert.ok(nearbyExplorationCategories(['cs.LG'], {}, ['hep-th']).every(id => ai.includes(id)));
  assert.ok(nearbyExplorationCategories(['cs.LG', 'quant-ph'], {}, ['hep-th']).every(id => ai.includes(id) || leavesOf('physics').includes(id)));
});

test('exploration skips the subareas the reader removed', () => {
  const nearby = nearbyExplorationCategories(['quant-ph'], {}, ['hep-th']);
  assert.equal(nearby.includes('hep-th'), false);
  assert.ok(['hep-ph', 'cond-mat.str-el', 'astro-ph.CO'].every(id => nearby.includes(id)));
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
      (paper as Partial<import('../models/paper.ts').Paper>)._dynamicScore = 1;
      (paper as Partial<import('../models/paper.ts').Paper>)._debugScore = {};
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
  // boost, six comparisons against five stored values. So the expensive half
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

test('a card straight from OpenAlex teaches only the concepts it may show as subjects', () => {
  // Shaped like formatOpenAlexWorkAsPaper, which keeps the work's concepts
  // unfiltered: the database MEDLINE says where a work is indexed, and a
  // concept scored 0.05 is barely about it.
  const medline = { id: 'https://openalex.org/C2779473830', display_name: 'MEDLINE', level: 2, score: 0.45 };
  const openAlexCard = (id: string) => ({
    id, primaryCategory: 'q-bio.NC', published: '2026-07-01T00:00:00Z',
    concepts: [medline, { id: 'https://openalex.org/C900010', display_name: 'Biology', level: 0, score: 0.05 }],
    primaryTopic: { id: 'https://openalex.org/T900004', display_name: 'Sleep and memory', score: 0.95 },
  });
  const sharesOnlyMedline = {
    id: 'openalex:W4', primaryCategory: 'q-bio.NC', published: '2026-07-01T00:00:00Z', concepts: [medline],
  };

  const reader = readerWhoLiked([openAlexCard('openalex:W1'), openAlexCard('openalex:W2'), openAlexCard('openalex:W3')]);

  assert.deepEqual(Object.keys(reader.conceptAffinities), ['T900004']);
  assert.equal(scorePaperForRecommendation(sharesOnlyMedline, reader).semantic, 0);
});

test('liking a paper stores what it is about and none of its words', () => {
  const card = {
    id: 'liked', primaryCategory: 'cs.LG', published: '2026-07-01T00:00:00Z', primaryTopic: RL_TOPIC,
    title: 'Offline reinforcement learning', abstract: 'A policy is learned from a fixed dataset of transitions.',
  };
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, {
    paperId: card.id, kind: 'like', category: card.primaryCategory, timestamp: NOW, ...paperAffinitySignals(card),
  }, NOW);

  const { affinities } = serializeInteractionProfile(profile);

  assert.match(affinities, /T900001/);
  assert.doesNotMatch(affinities, /offline|reinforcement|policy|dataset|transition/i);
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

test('access status changes neither scores nor shuffled recommendations after open or closed cards', () => {
  const card = (id: string, openAccess?: boolean) => ({
    id, primaryCategory: `med.${id}`, publicationStatus: 'published' as const,
    published: '2026-07-01T00:00:00Z', abstract: 'A study of clinical outcomes.', openAccess, _dynamicScore: 0,
  });
  const pool = [card('one', true), card('two', false), card('three')];
  const recommend = (access?: boolean, previousAccess?: boolean) => {
    const scores: number[] = [];
    const ranked = diversifiedWeightedShuffle(pool.map(paper => ({ ...paper, openAccess: access })), {
      initialPapers: ['a', 'b', 'c', 'd', 'e'].map(id => card(id, previousAccess)),
      random: () => 0.4,
      scorePaper: (paper, recentPropsCount) => {
        const result = scorePaperForRecommendation(paper, { now: NOW, recentPropsCount });
        scores.push(result.total);
        paper._dynamicScore = result.total;
      },
    });
    return { ids: ranked.map(paper => paper.id), scores };
  };
  const open = recommend(true);
  assert.deepEqual(open.ids, ['two', 'one', 'three']);
  for (const access of [true, false, undefined]) {
    for (const previousAccess of [true, false, undefined]) assert.deepEqual(recommend(access, previousAccess), open);
  }
});
