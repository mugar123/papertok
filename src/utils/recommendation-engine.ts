import type { Paper, PaperAuthor, PaperRecommendationScore } from '../models/paper.ts';
import type { FollowInput } from './following.ts';

import { hasUsableAIAbstract } from './ai-explanation-access.ts';
import { areaKeyForCategory, leavesForOpenAlexTopic } from './area-accent.ts';
import { getAllLeafCategories, getCategoryArea } from '../data/category-taxonomy.ts';
import { activeCategories } from './interest-memory.ts';
import { usableOpenAlexConcepts } from './open-alex-concepts.ts';

export type RecommendationWeights = { [K in keyof typeof DEFAULT_RECOMMENDATION_WEIGHTS]: number };
export interface RecentProperties { preprint: number; published: number; journal: number; conference: number; }
export interface RecommendationContext {
  weights?: Partial<RecommendationWeights>; now?: number; userPreferences?: string[] | null; followedAuthors?: string[];
  followedEntities?: FollowInput[]; categoryAffinities?: Record<string, number>;
  conceptAffinities?: Record<string, number>; authorAffinities?: Record<string, number>;
  sessionAffinities?: Record<string, number>; interactionCount?: number;
  // How far the app has learned each selected subarea, from 0 to 1 (see
  // interestProgress), the added picks it is still learning (coldAddedInterests)
  // and the subareas the reader's picks leave active. The learned signals
  // score only a paper of an active subarea; without the list none is dormant.
  interestProgress?: Record<string, number>; coldAdded?: string[]; activeCategories?: string[];
  temporalPreference?: number; recentPropsCount?: Partial<RecentProperties>;
}
interface Signal { id?: unknown; openAlexId?: unknown; canonicalId?: unknown; display_name?: unknown; displayName?: unknown; name?: unknown; label?: unknown; }
type StableScore = ReturnType<typeof computeStableScore>;
interface ShuffleOptions<T> {
  scorePaper?: (paper: T, recent: RecentProperties) => unknown; weights?: Partial<RecommendationWeights>;
  initialPapers?: T[]; random?: () => number; maxConsecutiveCategory?: number; poolCap?: number;
}

// Every score component is bounded so the weights below describe the REAL
// maximum contribution of each signal. Resulting hierarchy: preference and
// learned category affinity and corpus semantics (<=100) > follows (<=70) > learned concepts
// (<=semanticConceptMultiplier) > learned authors and the session (<=30) >
// citations/classics (<=25) > personal and graph candidates, diversity,
// recency. A card without an abstract loses missingAbstract: it reaches the
// page when the pool has little else or a follow carries it. The
// selected-category preference fades to minPreferenceShare of itself over
// preferenceFadeInteractions interactions: what the reader does takes over
// from what they picked at sign-up. An interest the reader added later fades
// instead as the app learns that subarea (interestProgress).
export const DEFAULT_RECOMMENDATION_WEIGHTS = Object.freeze({
  selectedCategory: 100,
  relatedSelectedCategory: 80,
  preferenceFadeInteractions: 300,
  minPreferenceShare: 0.3,
  followedAuthor: 50,
  followedTopic: 35,
  followedInstitution: 30,
  followedProject: 45,
  maxFollowBoost: 70,
  maxAffinity: 100,
  maxRecency: 5,
  recencyHalfLifeDays: 7,
  classicCitationMultiplier: 5,
  semanticConceptMultiplier: 50,
  maxCorpusSimilarity: 100,
  // Learned author affinity saturates at learnedAuthorScale, five likes'
  // worth on one author; the session at sessionScale, three strong reads.
  maxLearnedAuthor: 30,
  learnedAuthorScale: 25,
  maxSession: 30,
  sessionScale: 15,
  citationMultiplier: 5,
  maxCitationLog: 5,
  graphCandidate: 15,
  personalCandidate: 20,
  missingAbstract: 60,
  explorationBaseWeight: 5,
  exploitBaseWeight: 15,
  minShuffleWeight: 0.1,
});

export function mergeRecommendationWeights(overrides: Partial<RecommendationWeights> = {}): RecommendationWeights {
  return {
    ...DEFAULT_RECOMMENDATION_WEIGHTS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => Number.isFinite(value))
    ),
  };
}

export function readRecommendationWeights(storageKey = 'PAPERTOK_RECOMMENDATION_WEIGHTS') {
  if (typeof window === 'undefined') return DEFAULT_RECOMMENDATION_WEIGHTS;

  const globalOverrides = (window as Window & { PAPERTOK_RECOMMENDATION_WEIGHTS?: Partial<RecommendationWeights> }).PAPERTOK_RECOMMENDATION_WEIGHTS || {};
  const storedOverrides = (() => {
    try {
      const raw = window.localStorage?.getItem(storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })();

  return mergeRecommendationWeights({ ...globalOverrides, ...storedOverrides });
}

function daysSince(date: string | number | undefined, now: number) {
  const ts = new Date(date!).getTime();
  if (!Number.isFinite(ts)) return 30;
  return Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function topReasons(parts: Record<string, number>) {
  return Object.entries(parts)
    .filter(([, value]) => Math.abs(value) > 0.01)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([key, value]) => `${key}:${value.toFixed(1)}`);
}

// The explanation is only ever read by the ranking debug panel (behind
// localStorage.DEBUG_RANKING) and by logRankingBatch, yet it used to be built
// -- entries, filter, sort, slice, toFixed -- on every single score. As a lazy
// property it costs nothing until somebody looks, and still reads as a plain
// string for the two callers that do, with no flag to keep in sync.
//
// One looker is silent, so it is named here rather than left to be found by
// profiling: writeFeedSnapshot (context/feed-snapshot.ts) JSON.stringifies the
// persisted papers, and since the property is enumerable that serialisation invokes the
// getter on every _debugScore it walks -- up to FEED_SNAPSHOT_MAX_PAPERS of
// them per write. That is deliberate: the round trip has to yield the same
// string it always did, or a restored snapshot would stop matching a fresh
// score. Thirty topReasons calls per snapshot against N-squared per re-rank is
// still the trade we want; enumerable is not an oversight.
function defineExplanation<T extends object>(target: T, parts: Record<string, number>): T & { explanation: string } {
  let explanation: string|undefined;
  Object.defineProperty(target, 'explanation', {
    enumerable: true,
    configurable: true,
    get() {
      if (explanation === undefined) explanation = topReasons(parts).join(', ') || 'neutral';
      return explanation;
    },
    set(value: string) {
      explanation = value;
    },
  });
  return target as T & { explanation: string };
}

export function getPaperCategorySignals(paper: Partial<Paper>) {
  const providerCategories = paper?.allCategories || paper?.categories || [];
  return [...new Set([
    paper?.primaryCategory,
    ...(Array.isArray(providerCategories) ? providerCategories : []),
  ].filter(category => typeof category === 'string' && category.trim()))].slice(0, 6) as string[];
}

function normalizeSignalUncached(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:api\.)?openalex\.org\//, '')
    .replace(/^https?:\/\/(?:www\.)?ror\.org\//, '');
}

// Category ids, author names, institution URLs and topic labels repeat across
// papers and across re-ranks, so the NFD pass and the three regexes are worth
// paying once per distinct string. Only strings are cached: candidates arrive
// as objects too, and those would key on a toString the cache cannot trust.
const normalizedSignals = new Map<string, string>();
const NORMALIZED_SIGNAL_LIMIT = 5000;

function normalizeSignal(value: unknown) {
  if (typeof value !== 'string') return normalizeSignalUncached(value);

  const cached = normalizedSignals.get(value);
  if (cached !== undefined) return cached;

  const normalized = normalizeSignalUncached(value);
  // A long session can meet a lot of distinct signals; drop the whole map
  // rather than track ages, since a rebuild costs one pass over the live set.
  if (normalizedSignals.size >= NORMALIZED_SIGNAL_LIMIT) normalizedSignals.clear();
  normalizedSignals.set(value, normalized);
  return normalized;
}

function signalMatches(follow: Signal, candidates: Array<Signal | string | null | undefined>) {
  const followId = normalizeSignal(follow.canonicalId || follow.id);
  const followName = normalizeSignal(follow.displayName || follow.name);
  return candidates.some((candidate) => {
    const candidateId = normalizeSignal((candidate as Signal)?.id || (candidate as Signal)?.openAlexId || (candidate as Signal)?.canonicalId || candidate);
    const candidateName = normalizeSignal(
      (candidate as Signal)?.display_name || (candidate as Signal)?.displayName || (candidate as Signal)?.name || (candidate as Signal)?.label || candidate,
    );
    return Boolean((followId && candidateId === followId) || (followName && candidateName === followName));
  });
}

function followedTopicAliases(follow: FollowInput) {
  const canonicalId = String(follow.canonicalId || follow.id || '');
  const stableIds = [
    ...(/^query-/i.test(canonicalId) ? [] : [canonicalId]),
    ...(Array.isArray(follow.metadata?.categoryIds) ? follow.metadata.categoryIds : []),
  ];
  const names = [follow.metadata?.query, follow.displayName || follow.name];
  return [
    ...stableIds.map<Signal>(id => ({ id })),
    ...names.map<Signal>(name => ({ name })),
  ].filter(alias => alias.id || alias.name);
}

function paperTopicSignals(paper: Partial<Paper>) {
  return [
    ...getPaperCategorySignals(paper),
    ...(paper.concepts || []),
    ...(paper.openAlex?.concepts || []),
    ...(paper.topics || []),
    ...(paper.openAlex?.topics || []),
    paper.primaryTopic,
    paper.primary_topic,
    paper.openAlex?.primaryTopic,
    paper.openAlex?.primary_topic,
    ...(paper.keywords || []),
  ].filter(Boolean);
}

export function getFollowedEntitySignals(paper: Partial<Paper>, followedEntities: FollowInput[] = [], weights: RecommendationWeights = DEFAULT_RECOMMENDATION_WEIGHTS) {
  const topicCandidates = paperTopicSignals(paper);
  const authors = paper.authors || [];
  const institutions = paper.institutions || paper.openAlex?.institutions || [];
  const projects = [
    ...(paper.projectIds || []),
    ...(paper._followedEntityMatches || []),
  ];
  const matches = { author: false, topic: false, institution: false, project: false };

  followedEntities.forEach((follow) => {
    if (follow.type === 'author') matches.author ||= signalMatches(follow, authors);
    if (follow.type === 'topic') {
      matches.topic ||= followedTopicAliases(follow)
        .some(topicAlias => signalMatches(topicAlias, topicCandidates))
        || signalMatches(follow, paper._followedEntityMatches || []);
    }
    if (follow.type === 'institution') matches.institution ||= signalMatches(follow, institutions);
    if (follow.type === 'project') matches.project ||= signalMatches(follow, projects);
  });

  const raw = {
    author: matches.author ? weights.followedAuthor : 0,
    topic: matches.topic ? weights.followedTopic : 0,
    institution: matches.institution ? weights.followedInstitution : 0,
    project: matches.project ? weights.followedProject : 0,
  };
  return {
    matches,
    raw,
    total: Math.min(weights.maxFollowBoost, Object.values(raw).reduce((sum, value) => sum + value, 0)),
  };
}

// A collaboration paper can list hundreds of authors; the first ten are where a
// reader's interest in a group shows, and they keep the author map bounded.
const MAX_LEARNED_AUTHORS_PER_PAPER = 10;

function openAlexKey(value: unknown) {
  return String(value || '').trim().replace(/^https?:\/\/(?:api\.)?openalex\.org\//i, '');
}

function openAlexAuthorKey(author: PaperAuthor | string | null | undefined) {
  const key = openAlexKey(typeof author === 'object' ? author?.id : '').toUpperCase();
  return /^A\d+$/.test(key) ? key : '';
}

/**
 * The OpenAlex concepts and authors a paper carries, keyed the way the
 * interaction profile learns them and the ranking reads them back. Authors
 * without an OpenAlex id are left out: a name is not an identity.
 */
export function paperAffinitySignals(paper: Partial<Paper>) {
  // The concepts and topics of OpenAlex's own record, then those the card
  // carries itself (a card from OpenAlex has them before any enrichment), each
  // id once. Of the card's own, only OpenAlex concept and topic ids count:
  // other providers file their keywords there under ids made up for that one
  // record (`epmc:<pmid>:<index>`) or that restate the category
  // (`biorxiv:<collection>`), which would match no other card or count the
  // category twice. A card mapped straight from an OpenAlex work keeps all of
  // its concepts, so they pass the same subject rule the enrichment applies
  // (no MEDLINE, nothing scored 0.3 or less).
  const toSignal = (concept: { id?: unknown; score?: number } | null | undefined) => ({ id: openAlexKey(concept?.id), score: concept?.score });
  const carried = [
    ...(paper?.openAlex?.concepts || []).map(toSignal).filter(concept => concept.id),
    ...usableOpenAlexConcepts([...(paper?.concepts || []), ...(paper?.topics || []), ...(paper?.primaryTopic ? [paper.primaryTopic] : [])])
      .map(toSignal).filter(concept => /^[CT]\d+$/.test(concept.id)),
  ];
  const concepts = carried.filter((concept, index) => carried.findIndex(other => other.id === concept.id) === index);
  const authorIds = [...new Set(
    (paper?.authors || []).slice(0, MAX_LEARNED_AUTHORS_PER_PAPER).map(openAlexAuthorKey).filter(Boolean),
  )];
  return { concepts, authorIds };
}

function conceptWeight(score: number | undefined) {
  return Number.isFinite(score) ? clamp(score!, 0, 1) : 1;
}

const NEUTRAL_RECENT_PROPS = Object.freeze({
  preprint: 0, published: 0, journal: 0, conference: 0,
});

// The areas with a subarea in the list, per list: a score asks once per paper.
const activeAreas = new WeakMap<string[], Set<string>>();

function activeAreasOf(activeCategories: string[]) {
  let areas = activeAreas.get(activeCategories);
  if (!areas) {
    areas = new Set(activeCategories.map(category => areaKeyForCategory(category)).filter((area): area is NonNullable<typeof area> => area !== null));
    activeAreas.set(activeCategories, areas);
  }
  return areas;
}

// Whether a card belongs to one of the reader's active subareas even when it
// names no leaf of its own: a working paper is filed under its area ('econ'),
// an arXiv paper under a category the taxonomy has no leaf for ('math.AC',
// active with its archive's area), an area-lane article under OpenAlex
// concept names, and a specialist source's card carries only the leaf it was
// fetched for. A card of the main
// corpus request is active by construction: its lanes are the active ones.
// Only evidence of an area makes a card dormant: one that says nothing of its
// area (a followed author's article filed under concept names) stays active,
// as the Worker ranks a like with no area for every group.
function isInActiveSubarea(paper: Partial<Paper>, categories: string[], activeCategories: string[]) {
  const areas = activeAreasOf(activeCategories);
  const areaCategories = categories.filter(category => areaKeyForCategory(category));
  const topicLeaves = leavesForOpenAlexTopic(paper.primaryTopic);
  const fetchedFor = paper._fetchedFor ?? [];
  return paper._type === 'exploit'
    || areaCategories.some(category => activeCategories.includes(category)
      || (!getCategoryArea(category) && areas.has(areaKeyForCategory(category)!)))
    || topicLeaves.some(leaf => activeCategories.includes(leaf))
    || fetchedFor.some(category => activeCategories.includes(category))
    || (areaCategories.length === 0 && topicLeaves.length === 0 && fetchedFor.length === 0);
}

// Everything a score needs that does NOT move with the recent window: the
// followed-entity matching, the topic flattening, affinities, cooldowns,
// recency. A diversified shuffle asks for the same paper once per remaining
// pool slot, and only the diversity boost differs between those calls, so this
// half is computed once per paper and reused (see beginScoringRun).
function computeStableScore(paper: Partial<Paper>, context: RecommendationContext) {
  const weights = mergeRecommendationWeights(context.weights);
  const now = context.now || Date.now();
  const userPreferences = context.userPreferences || [];
  const followedAuthors = context.followedAuthors || [];
  const followedEntities = context.followedEntities || [];
  const categoryAffinities = context.categoryAffinities || {};
  const conceptAffinities = context.conceptAffinities || {};
  const authorAffinities = context.authorAffinities || {};
  const sessionAffinities = context.sessionAffinities || {};
  const temporalPreference = context.temporalPreference || 0;
  const interestProgress = context.interestProgress || {};
  const coldAdded = context.coldAdded || [];

  const categorySignals = getPaperCategorySignals(paper);
  const primaryCategory = categorySignals[0] || '';
  const allCategories = categorySignals;
  const isExploration = paper._debugScore?.isExploration || paper._type === 'exploration';

  const picked = (category: string) => userPreferences.includes(category);
  // OpenAlex files a work under its own topic, never under a leaf; a chosen
  // leaf whose topic list holds that topic counts as its primary category.
  // A specialist source's card seldom names a category of the taxonomy. When
  // the source was asked for one of the reader's, the card earns that
  // category's preference without claiming the category.
  const chosenDirectly = [primaryCategory, ...leavesForOpenAlexTopic(paper.primaryTopic), ...(paper._fetchedFor || [])].filter(picked);
  const chosenAsRelated = allCategories.filter(picked);
  const matched = chosenDirectly.length > 0 ? chosenDirectly : chosenAsRelated;
  // An added pick the app is still learning keeps the share its progress
  // leaves; any other pick fades with the reader's interactions. A card that
  // matches several weighs by the most-learned.
  const establishedShare = Math.max(
    weights.minPreferenceShare,
    1 - (context.interactionCount || 0) / weights.preferenceFadeInteractions,
  );
  const shareOf = (category: string) => (coldAdded.includes(category)
    ? Math.max(weights.minPreferenceShare, 1 - (interestProgress[category] || 0) * (1 - weights.minPreferenceShare))
    : establishedShare);
  const preferenceShare = Math.min(1, ...matched.map(shareOf));
  // What the reader learned about a subject they left, or never picked, stays
  // stored but ranks nothing here. A follow and the card's own signals still do.
  const isActive = !context.activeCategories
    || chosenDirectly.length > 0
    || isInActiveSubarea(paper, categorySignals, context.activeCategories);

  const rawAffinity = categorySignals.reduce((sum, category, index) => {
    const multiplier = index === 0 ? 1 : 0.35;
    return sum + (categoryAffinities[category] || 0) * multiplier;
  }, 0);
  // Secondary categories can push the sum past the per-category clamp; cap it so
  // learned affinity never outweighs an explicit preference by accumulation alone.
  const affinity = isActive ? clamp(rawAffinity, -weights.maxAffinity, weights.maxAffinity) : 0;

  let preference = 0;
  if (chosenDirectly.length > 0) preference = weights.selectedCategory * preferenceShare;
  else if (chosenAsRelated.length > 0) preference = weights.relatedSelectedCategory * preferenceShare;

  const authorBoost = paper.authors?.some((author) => followedAuthors.includes(((author as PaperAuthor)?.name || author) as string))
    ? weights.followedAuthor
    : 0;
  const followedSignals = getFollowedEntitySignals(paper, followedEntities, weights);
  const followBoost = Math.max(authorBoost, followedSignals.total);

  const ageDays = daysSince(paper.published, now);
  const recency = Math.max(0, weights.maxRecency * Math.exp(-ageDays / weights.recencyHalfLifeDays))
    * (1 + temporalPreference);

  const citedBy = paper.citationCount ?? 0;
  // log10 saturates at maxCitationLog (10^5 citations) so mega-cited classics
  // cannot grow without bound.
  const classicBoost = temporalPreference < 0 && ageDays > 365 && citedBy > 10
    ? Math.abs(temporalPreference) * Math.min(Math.log10(citedBy), weights.maxCitationLog) * weights.classicCitationMultiplier
    : 0;

  // Concept match normalized to [-1, 1]: each concept contributes its OpenAlex
  // confidence times the learned affinity as a fraction of the affinity clamp
  // (100), so semanticConceptMultiplier IS the maximum semantic contribution.
  // Before this, the raw product reached hundreds of points per concept and
  // whether OpenAlex enrichment had arrived decided the ranking's character.
  const { concepts, authorIds } = paperAffinitySignals(paper);
  const semanticMatch = concepts.reduce((sum, concept) => {
    const affinityValue = conceptAffinities[concept.id] || 0;
    return sum + conceptWeight(concept.score) * (affinityValue / 100);
  }, 0);
  const semantic = isActive ? clamp(semanticMatch, -1, 1) * weights.semanticConceptMultiplier : 0;
  const corpusSimilarity = isActive && Number.isFinite(paper._semanticScore)
    ? clamp(paper._semanticScore!, -1, 1) * weights.maxCorpusSimilarity : 0;

  // Authors the reader keeps engaging with, learned rather than followed.
  const authorMatch = authorIds.reduce((sum, authorId) => sum + (authorAffinities[authorId] || 0), 0);
  const learnedAuthor = isActive ? clamp(authorMatch / weights.learnedAuthorScale, -1, 1) * weights.maxLearnedAuthor : 0;

  // What this session has been engaging with in the last dozen cards or so:
  // the primary category and the concepts, each weighed as above.
  const sessionMatch = (primaryCategory ? sessionAffinities[primaryCategory] || 0 : 0)
    + concepts.reduce((sum, concept) => sum + conceptWeight(concept.score) * (sessionAffinities[concept.id] || 0), 0);
  const sessionInterest = isActive ? clamp(sessionMatch / weights.sessionScale, -1, 1) * weights.maxSession : 0;

  const citations = citedBy > 0
    ? Math.min(Math.log10(citedBy + 1), weights.maxCitationLog) * weights.citationMultiplier
    : 0;

  const graphBoost = paper._isGraphCandidate ? weights.graphCandidate : 0;
  const personalBoost = paper._isPersonalCandidate ? weights.personalCandidate : 0;
  const missingAbstract = hasUsableAIAbstract(paper.abstract) ? 0 : -weights.missingAbstract;

  // The window-independent components; the diversity boost is added afterwards.
  const stableParts = {
    affinity,
    preference,
    recency,
    classicBoost,
    semantic,
    corpusSimilarity,
    learnedAuthor,
    sessionInterest,
    citations,
    graphBoost,
    personalBoost,
    followBoost,
    missingAbstract,
  };

  return {
    // What the cached half depends on. The context object is rebuilt on every
    // call (FeedContext spreads a literal), so the entry is validated against
    // these references rather than against the object holding them.
    weightsSource: context.weights,
    userPreferences: context.userPreferences,
    followedAuthors: context.followedAuthors,
    followedEntities: context.followedEntities,
    categoryAffinities: context.categoryAffinities,
    conceptAffinities: context.conceptAffinities,
    authorAffinities: context.authorAffinities,
    sessionAffinities: context.sessionAffinities,
    interactionCount: context.interactionCount,
    interestProgress: context.interestProgress,
    coldAdded: context.coldAdded,
    activeCategories: context.activeCategories,
    temporalPreference: context.temporalPreference,
    explicitNow: context.now,

    stableParts,
    stableTotal: Object.values(stableParts).reduce((sum, value) => sum + value, 0),
    authorBoost: Math.max(authorBoost, followedSignals.raw.author),
    followedEntityMatches: followedSignals.matches,
    isExploration,

    // What the diversity rule tests. Reading it off the paper is trivial, but
    // keeping it here means the per-iteration work is four comparisons and
    // nothing else.
    isPreprint: paper.publicationStatus === 'preprint' || paper.publicationType === 'preprint',
    isPublished: paper.publicationStatus === 'published',
    isJournal: paper.sourceType === 'journal' || paper.journal,
    isConference: paper.sourceType === 'conference' || paper.conference,

    // Last assembled result, reused while the boost holds its value.
    lastDiversityBoost: null as number | null,
    lastResult: null as PaperRecommendationScore | null,
  };
}

// --- Content Diversity Soft Constraints ---
// If the last 5 cards are saturated with one type, boost the opposite type.
// This is the whole of the score that moves as the shuffle advances.
function diversityBoostFor(stable: StableScore, recentPropsCount: Partial<RecentProperties>) {
  let diversityBoost = 0;

  if (recentPropsCount.published! >= 4 && stable.isPreprint) diversityBoost += 10;
  if (recentPropsCount.preprint! >= 4 && stable.isPublished) diversityBoost += 10;

  if (recentPropsCount.conference! >= 3 && stable.isJournal) diversityBoost += 8;
  if (recentPropsCount.journal! >= 4 && stable.isConference) diversityBoost += 5;

  return diversityBoost;
}

// A re-rank scores each paper once per remaining pool slot: N(N+1)/2 calls for
// a pool of N, all but the diversity boost identical. A run holds the stable
// half of each paper's score for exactly one shuffle and is dropped afterwards.
//
// It has to be scoped that tightly. A module-level cache keyed by paper would
// go stale between re-ranks: it would keep answering with the affinities of the
// run that filled it, which ignore the reader's last swipe.
let activeScoringRun: Map<Partial<Paper>, StableScore> | null = null;

function beginScoringRun() {
  const previous = activeScoringRun;
  activeScoringRun = new Map();
  return () => { activeScoringRun = previous; };
}

function stableScoreFor(paper: Partial<Paper>, context: RecommendationContext) {
  const run = activeScoringRun;
  if (!run) return computeStableScore(paper, context);

  const cached = run.get(paper);
  if (cached
    && cached.weightsSource === context.weights
    && cached.userPreferences === context.userPreferences
    && cached.followedAuthors === context.followedAuthors
    && cached.followedEntities === context.followedEntities
    && cached.categoryAffinities === context.categoryAffinities
    && cached.conceptAffinities === context.conceptAffinities
    && cached.authorAffinities === context.authorAffinities
    && cached.sessionAffinities === context.sessionAffinities
    && cached.interactionCount === context.interactionCount
    && cached.interestProgress === context.interestProgress
    && cached.coldAdded === context.coldAdded
    && cached.activeCategories === context.activeCategories
    && cached.temporalPreference === context.temporalPreference
    && cached.explicitNow === context.now) {
    return cached;
  }

  const stable = computeStableScore(paper, context);
  run.set(paper, stable);
  return stable;
}

export function scorePaperForRecommendation(paper: Partial<Paper>, context: RecommendationContext = {}): PaperRecommendationScore {
  const stable = stableScoreFor(paper, context);
  const recentPropsCount = context.recentPropsCount || NEUTRAL_RECENT_PROPS;
  const diversityBoost = diversityBoostFor(stable, recentPropsCount);

  // Same paper, same boost: the score is identical, so hand back the very same
  // breakdown instead of rebuilding it. Keeps _debugScore stable for React too.
  if (stable.lastResult && stable.lastDiversityBoost === diversityBoost) return stable.lastResult;

  const parts = { ...stable.stableParts, diversityBoost };
  const total = stable.stableTotal + diversityBoost;

  const result = defineExplanation({
    total,
    ...parts,
    authorBoost: stable.authorBoost,
    followedEntityMatches: stable.followedEntityMatches,
    isExploration: stable.isExploration,
  }, parts);

  stable.lastDiversityBoost = diversityBoost;
  stable.lastResult = result;
  return result;
}

export function applyRecommendationScore<T extends Partial<Paper>>(paper: T, context: RecommendationContext = {}): T {
  const debugScore = scorePaperForRecommendation(paper, context);
  paper._dynamicScore = debugScore.total;
  paper._debugScore = debugScore;
  return paper;
}

function countRecentProperties(papers: Partial<Paper>[]) {
  const counts = { preprint: 0, published: 0, journal: 0, conference: 0 };

  papers.forEach((paper) => {
    if (paper.publicationStatus === 'preprint' || paper.publicationType === 'preprint') counts.preprint += 1;
    else if (paper.publicationStatus === 'published') counts.published += 1;

    if (paper.sourceType === 'journal' || paper.journal) counts.journal += 1;
    if (paper.sourceType === 'conference' || paper.conference) counts.conference += 1;
  });

  return counts;
}

function getTrailingCategoryRun(papers: Partial<Paper>[]) {
  const lastCategory = papers.at(-1)?.primaryCategory || '';
  if (!lastCategory) return { lastCategory: '', count: 0 };

  let count = 0;
  for (let index = papers.length - 1; index >= 0; index -= 1) {
    if (papers[index]?.primaryCategory !== lastCategory) break;
    count += 1;
  }
  return { lastCategory, count };
}

// The visible page is 15 cards. Scoring and shuffling hundreds of extras is
// main-thread work the reader never sees; keep a scored head that is still
// wide enough for diversity, then shuffle that.
export const FEED_SHUFFLE_POOL_CAP = 80;

export function trimScoredCandidatePool<T extends Partial<Paper>>(papers: T[], options: Pick<ShuffleOptions<T>, 'scorePaper'> & { cap?: number } = {}): T[] {
  const list = Array.isArray(papers) ? [...papers] : [];
  const requestedCap = options.cap ?? FEED_SHUFFLE_POOL_CAP;
  const cap = Number.isFinite(requestedCap) ? Math.max(0, Math.floor(requestedCap)) : FEED_SHUFFLE_POOL_CAP;
  if (list.length <= cap) return list;
  const scorePaper = options.scorePaper;
  if (typeof scorePaper === 'function') {
    const emptyRecent = {
      preprint: 0, published: 0, journal: 0, conference: 0,
    };
    list.forEach((paper) => scorePaper(paper, emptyRecent));
  }
  list.sort((left, right) => (right._dynamicScore || 0) - (left._dynamicScore || 0));
  return list.slice(0, cap);
}

export function diversifiedWeightedShuffle<T extends Partial<Paper>>(papers: T[], options: ShuffleOptions<T> = {}): T[] {
  const {
    scorePaper,
    weights = DEFAULT_RECOMMENDATION_WEIGHTS,
    initialPapers = [],
    random = Math.random,
    maxConsecutiveCategory = 3,
    poolCap = FEED_SHUFFLE_POOL_CAP,
  } = options;

  const config = mergeRecommendationWeights(weights);
  const pool = trimScoredCandidatePool(papers, { scorePaper, cap: poolCap });
  const result = [];
  const history = [...initialPapers];
  let { lastCategory, count: consecutiveCategoryCount } = getTrailingCategoryRun(history);

  // One re-rank, one scoring run: every paper still gets re-scored against the
  // evolving recent window on every iteration, but the expensive half of that
  // score is now computed once per paper and reused inside this shuffle only.
  const endScoringRun = beginScoringRun();
  try {
    while (pool.length > 0) {
      const recentPropsCount = countRecentProperties(history.slice(-5));
      if (typeof scorePaper === 'function') {
        pool.forEach(paper => scorePaper(paper, recentPropsCount));
      }

      let candidateIndexes = pool.map((_, index) => index);
      if (lastCategory && consecutiveCategoryCount >= maxConsecutiveCategory) {
        const alternatives = candidateIndexes.filter(index => pool[index].primaryCategory !== lastCategory);
        if (alternatives.length > 0) candidateIndexes = alternatives;
      }

      const candidateWeights = candidateIndexes.map((poolIndex) => {
        const paper = pool[poolIndex];
        const isExplore = paper._debugScore?.isExploration || paper._type === 'exploration';
        const score = paper._dynamicScore || 0;
        const baseWeight = isExplore ? config.explorationBaseWeight : config.exploitBaseWeight;
        return Math.max(config.minShuffleWeight, score + baseWeight);
      });
      const totalWeight = candidateWeights.reduce((sum, weight) => sum + weight, 0);

      let candidateIndex = 0;
      if (totalWeight > 0) {
        let cursor = random() * totalWeight;
        for (let index = 0; index < candidateIndexes.length; index += 1) {
          cursor -= candidateWeights[index];
          if (cursor <= 0) {
            candidateIndex = index;
            break;
          }
        }
      } else {
        candidateIndex = Math.floor(random() * candidateIndexes.length);
      }

      const selectedPoolIndex = candidateIndexes[candidateIndex];
      const [selectedPaper] = pool.splice(selectedPoolIndex, 1);
      result.push(selectedPaper);
      history.push(selectedPaper);

      const category = selectedPaper.primaryCategory || '';
      if (category && category === lastCategory) {
        consecutiveCategoryCount += 1;
      } else {
        lastCategory = category;
        consecutiveCategoryCount = category ? 1 : 0;
      }
    }
  } finally {
    endScoringRun();
  }

  return result;
}

// Box–Muller: one standard normal draw from two uniforms.
function standardNormal(random: () => number) {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia and Tsang, valid for shape >= 1, which is all a Beta with a uniform
// prior ever needs. Almost every first try is accepted; the cap only stops a
// degenerate random source from spinning forever.
function sampleGamma(shape: number, random: () => number) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const x = standardNormal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    if (Math.log(random()) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}

function sampleBeta(alpha: number, beta: number, random: () => number) {
  const x = sampleGamma(alpha, random);
  return x / (x + sampleGamma(beta, random));
}

/**
 * Thompson sampling over the categories offered for exploration. Each draws a
 * plausible engagement rate from Beta(1 + engaged, 1 + not engaged) and the
 * highest draws win. A category never shown draws from the uniform prior and
 * gets its chance; one shown often and skipped draws low and stops being
 * offered; one that keeps holding the reader keeps coming back.
 */
/**
 * The leaves exploration chooses from: the reader's active subareas
 * (activeCategories) they have not picked, less any they have turned away
 * from. A subarea they removed sleeps, and is not explored either.
 */
export function nearbyExplorationCategories(preferences: string[], affinities: Record<string, number> = {}, deselected: string[] = []) {
  const leaves = new Set(getAllLeafCategories().map(leaf => leaf.id));
  return [...activeCategories(preferences, deselected)]
    .filter(id => leaves.has(id) && !preferences.includes(id) && (affinities[id] || 0) >= -2);
}

export function pickExplorationCategories(
  categoryIds: string[],
  exposure: Record<string, { shown: number; engaged: number }> = {},
  count = 3,
  random: () => number = Math.random,
) {
  return categoryIds
    .map((id) => {
      const shown = exposure[id]?.shown || 0;
      const engaged = Math.min(shown, exposure[id]?.engaged || 0);
      return [id, sampleBeta(1 + engaged, 1 + shown - engaged, random)] as const;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([id]) => id);
}

export function shouldLogRanking() {
  if (typeof window === 'undefined') return false;
  return window.localStorage?.getItem('DEBUG_RANKING') === 'true';
}

export function logRankingBatch(label: string, papers: Partial<Paper>[], limit = 10) {
  if (!shouldLogRanking()) return;
  const rows = papers.slice(0, limit).map((paper, index) => ({
    rank: index + 1,
    id: paper.id,
    type: paper._type || 'unknown',
    category: paper.primaryCategory || '',
    score: Number((paper._debugScore?.total || 0).toFixed(2)),
    explanation: paper._debugScore?.explanation || '',
  }));
  console.table(rows);
  console.debug(`[PaperTok ranking] ${label}`, rows);
}
