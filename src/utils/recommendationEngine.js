// Every score component is bounded so the weights below describe the REAL
// maximum contribution of each signal. Resulting hierarchy: preference and
// learned affinity (<=100) > follows (<=70) > citations/classics (<=25) >
// semantic concepts (<=semanticConceptMultiplier) > graph/diversity/recency.
export const DEFAULT_RECOMMENDATION_WEIGHTS = Object.freeze({
  selectedCategory: 100,
  relatedSelectedCategory: 80,
  followedAuthor: 50,
  followedTopic: 35,
  followedInstitution: 30,
  followedProject: 45,
  maxFollowBoost: 70,
  maxAffinity: 100,
  maxRecency: 5,
  recencyHalfLifeDays: 7,
  classicCitationMultiplier: 5,
  semanticConceptMultiplier: 20,
  citationMultiplier: 5,
  maxCitationLog: 5,
  graphCandidate: 15,
  explorationBaseWeight: 5,
  exploitBaseWeight: 15,
  minShuffleWeight: 0.1,
  cooldownDays: 14,
  minCooldownMultiplier: 0.1,
});

export function mergeRecommendationWeights(overrides = {}) {
  return {
    ...DEFAULT_RECOMMENDATION_WEIGHTS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => Number.isFinite(value))
    ),
  };
}

export function readRecommendationWeights(storageKey = 'PAPERTOK_RECOMMENDATION_WEIGHTS') {
  if (typeof window === 'undefined') return DEFAULT_RECOMMENDATION_WEIGHTS;

  const globalOverrides = window.PAPERTOK_RECOMMENDATION_WEIGHTS || {};
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

function daysSince(date, now) {
  const ts = new Date(date).getTime();
  if (!Number.isFinite(ts)) return 30;
  return Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function topReasons(parts) {
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
// profiling: writeFeedSnapshot (FeedContext) JSON.stringifies the persisted
// papers, and since the property is enumerable that serialisation invokes the
// getter on every _debugScore it walks -- up to FEED_SNAPSHOT_MAX_PAPERS of
// them per write. That is deliberate: the round trip has to yield the same
// string it always did, or a restored snapshot would stop matching a fresh
// score. Thirty topReasons calls per snapshot against N-squared per re-rank is
// still the trade we want; enumerable is not an oversight.
function defineExplanation(target, parts) {
  let explanation;
  Object.defineProperty(target, 'explanation', {
    enumerable: true,
    configurable: true,
    get() {
      if (explanation === undefined) explanation = topReasons(parts).join(', ') || 'neutral';
      return explanation;
    },
    set(value) {
      explanation = value;
    },
  });
  return target;
}

export function getPaperCategorySignals(paper) {
  const providerCategories = paper?.allCategories || paper?.categories || [];
  return [...new Set([
    paper?.primaryCategory,
    ...(Array.isArray(providerCategories) ? providerCategories : []),
  ].filter(category => typeof category === 'string' && category.trim()))].slice(0, 6);
}

function normalizeSignalUncached(value) {
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
const normalizedSignals = new Map();
const NORMALIZED_SIGNAL_LIMIT = 5000;

function normalizeSignal(value) {
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

function signalMatches(follow, candidates) {
  const followId = normalizeSignal(follow.canonicalId || follow.id);
  const followName = normalizeSignal(follow.displayName || follow.name);
  return candidates.some((candidate) => {
    const candidateId = normalizeSignal(candidate?.id || candidate?.openAlexId || candidate?.canonicalId || candidate);
    const candidateName = normalizeSignal(
      candidate?.display_name || candidate?.displayName || candidate?.name || candidate?.label || candidate,
    );
    return Boolean((followId && candidateId === followId) || (followName && candidateName === followName));
  });
}

function followedTopicAliases(follow) {
  const canonicalId = String(follow.canonicalId || follow.id || '');
  const stableIds = [
    ...(/^query-/i.test(canonicalId) ? [] : [canonicalId]),
    ...(Array.isArray(follow.metadata?.categoryIds) ? follow.metadata.categoryIds : []),
  ];
  const names = [follow.metadata?.query, follow.displayName || follow.name];
  return [
    ...stableIds.map(id => ({ id })),
    ...names.map(name => ({ name })),
  ].filter(alias => alias.id || alias.name);
}

function paperTopicSignals(paper) {
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

export function getFollowedEntitySignals(paper, followedEntities = [], weights = DEFAULT_RECOMMENDATION_WEIGHTS) {
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

export function applyCategoryAffinityDelta(affinities, paper, delta, secondaryMultiplier = 0.35) {
  const categories = getPaperCategorySignals(paper);
  categories.forEach((category, index) => {
    const categoryDelta = index === 0 ? delta : delta * secondaryMultiplier;
    affinities[category] = (affinities[category] || 0) + categoryDelta;
  });
  return affinities;
}

const NEUTRAL_RECENT_PROPS = Object.freeze({
  preprint: 0, published: 0, openAccess: 0, subscription: 0, journal: 0, conference: 0,
});

// Everything a score needs that does NOT move with the recent window: the
// followed-entity matching, the topic flattening, affinities, cooldowns,
// recency. A diversified shuffle asks for the same paper once per remaining
// pool slot, and only the diversity boost differs between those calls, so this
// half is computed once per paper and reused (see beginScoringRun).
function computeStableScore(paper, context) {
  const weights = mergeRecommendationWeights(context.weights);
  const now = context.now || Date.now();
  const userPreferences = context.userPreferences || [];
  const followedAuthors = context.followedAuthors || [];
  const followedEntities = context.followedEntities || [];
  const categoryAffinities = context.categoryAffinities || {};
  const categoryCooldowns = context.categoryCooldowns || {};
  const conceptAffinities = context.conceptAffinities || {};
  const temporalPreference = context.temporalPreference || 0;

  const categorySignals = getPaperCategorySignals(paper);
  const primaryCategory = categorySignals[0] || '';
  const allCategories = categorySignals;
  const isExploration = paper._debugScore?.isExploration || paper._type === 'exploration';

  const rawAffinity = categorySignals.reduce((sum, category, index) => {
    const multiplier = index === 0 ? 1 : 0.35;
    return sum + (categoryAffinities[category] || 0) * multiplier;
  }, 0);
  // Secondary categories can push the sum past the per-category clamp; cap it so
  // learned affinity never outweighs an explicit preference by accumulation alone.
  const affinity = clamp(rawAffinity, -weights.maxAffinity, weights.maxAffinity);

  let preference = 0;
  if (primaryCategory && userPreferences.includes(primaryCategory)) {
    preference = weights.selectedCategory;
  } else if (allCategories.some((cat) => userPreferences.includes(cat))) {
    preference = weights.relatedSelectedCategory;
  }

  const authorBoost = paper.authors?.some((author) => followedAuthors.includes(author?.name || author))
    ? weights.followedAuthor
    : 0;
  const followedSignals = getFollowedEntitySignals(paper, followedEntities, weights);
  const followBoost = Math.max(authorBoost, followedSignals.total);

  const ageDays = daysSince(paper.published, now);
  const recency = Math.max(0, weights.maxRecency * Math.exp(-ageDays / weights.recencyHalfLifeDays))
    * (1 + temporalPreference);

  const citedBy = paper.openAlex?.cited_by_count ?? paper.openAlex?.citationCount ?? paper.citationCount ?? 0;
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
  const semanticMatch = (paper.openAlex?.concepts || []).reduce((sum, concept) => {
    const affinityValue = conceptAffinities[concept.id] || 0;
    return sum + (concept.score || 0) * (affinityValue / 100);
  }, 0);
  const semantic = clamp(semanticMatch, -1, 1) * weights.semanticConceptMultiplier;

  const citations = citedBy > 0
    ? Math.min(Math.log10(citedBy + 1), weights.maxCitationLog) * weights.citationMultiplier
    : 0;

  const graphBoost = paper._isGraphCandidate ? weights.graphCandidate : 0;

  let cooldownMultiplier = 1;
  if (primaryCategory && categoryCooldowns[primaryCategory]) {
    const cooldownAge = daysSince(categoryCooldowns[primaryCategory], now);
    if (cooldownAge < weights.cooldownDays) {
      cooldownMultiplier = weights.minCooldownMultiplier
        + ((1 - weights.minCooldownMultiplier) * (cooldownAge / weights.cooldownDays));
      cooldownMultiplier = clamp(cooldownMultiplier, weights.minCooldownMultiplier, 1);
    }
  }

  // The eight window-independent components, in the order the total used to sum
  // them; the diversity boost is added afterwards, exactly where it always was,
  // so the arithmetic is unchanged down to the last float.
  const stableParts = {
    affinity,
    preference,
    recency,
    classicBoost,
    semantic,
    citations,
    graphBoost,
    followBoost,
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
    categoryCooldowns: context.categoryCooldowns,
    conceptAffinities: context.conceptAffinities,
    temporalPreference: context.temporalPreference,
    explicitNow: context.now,

    stableParts,
    stableTotal: Object.values(stableParts).reduce((sum, value) => sum + value, 0),
    cooldownMultiplier,
    authorBoost: Math.max(authorBoost, followedSignals.raw.author),
    followedEntityMatches: followedSignals.matches,
    isExploration,

    // The five booleans the diversity rule tests. Reading them off the paper is
    // trivial, but keeping them here means the per-iteration work is six
    // integer comparisons and nothing else.
    isPreprint: paper.publicationStatus === 'preprint' || paper.publicationType === 'preprint',
    isPublished: paper.publicationStatus === 'published',
    isOA: paper.openAccess,
    isJournal: paper.sourceType === 'journal' || paper.journal,
    isConference: paper.sourceType === 'conference' || paper.conference,

    // Last assembled result, reused while the boost holds its value.
    lastDiversityBoost: null,
    lastResult: null,
  };
}

// --- Content Diversity Soft Constraints ---
// If the last 5 cards are saturated with one type, boost the opposite type.
// This is the whole of the score that moves as the shuffle advances.
function diversityBoostFor(stable, recentPropsCount) {
  let diversityBoost = 0;

  if (recentPropsCount.published >= 4 && stable.isPreprint) diversityBoost += 10;
  if (recentPropsCount.preprint >= 4 && stable.isPublished) diversityBoost += 10;

  if (recentPropsCount.subscription >= 3 && stable.isOA) diversityBoost += 8;
  if (recentPropsCount.openAccess >= 4 && !stable.isOA) diversityBoost += 5;

  if (recentPropsCount.conference >= 3 && stable.isJournal) diversityBoost += 8;
  if (recentPropsCount.journal >= 4 && stable.isConference) diversityBoost += 5;

  return diversityBoost;
}

// A re-rank scores each paper once per remaining pool slot: N(N+1)/2 calls for
// a pool of N, all but the diversity boost identical. A run holds the stable
// half of each paper's score for exactly one shuffle and is dropped afterwards.
//
// It has to be scoped that tightly. A module-level cache keyed by paper would
// go stale between re-ranks, because FeedContext mutates its affinity and
// cooldown maps IN PLACE (applyCategoryAffinityDelta, categoryCooldowns.current
// [category] = Date.now()): entries kept across runs would keep answering with
// scores that ignore the reader's last swipe.
let activeScoringRun = null;

function beginScoringRun() {
  const previous = activeScoringRun;
  activeScoringRun = new Map();
  return () => { activeScoringRun = previous; };
}

function stableScoreFor(paper, context) {
  const run = activeScoringRun;
  if (!run) return computeStableScore(paper, context);

  const cached = run.get(paper);
  if (cached
    && cached.weightsSource === context.weights
    && cached.userPreferences === context.userPreferences
    && cached.followedAuthors === context.followedAuthors
    && cached.followedEntities === context.followedEntities
    && cached.categoryAffinities === context.categoryAffinities
    && cached.categoryCooldowns === context.categoryCooldowns
    && cached.conceptAffinities === context.conceptAffinities
    && cached.temporalPreference === context.temporalPreference
    && cached.explicitNow === context.now) {
    return cached;
  }

  const stable = computeStableScore(paper, context);
  run.set(paper, stable);
  return stable;
}

export function scorePaperForRecommendation(paper, context = {}) {
  const stable = stableScoreFor(paper, context);
  const recentPropsCount = context.recentPropsCount || NEUTRAL_RECENT_PROPS;
  const diversityBoost = diversityBoostFor(stable, recentPropsCount);

  // Same paper, same boost: the score is identical, so hand back the very same
  // breakdown instead of rebuilding it. Keeps _debugScore stable for React too.
  if (stable.lastResult && stable.lastDiversityBoost === diversityBoost) return stable.lastResult;

  const parts = { ...stable.stableParts, diversityBoost };
  const baseTotal = stable.stableTotal + diversityBoost;
  const total = baseTotal * stable.cooldownMultiplier;

  const result = defineExplanation({
    total,
    baseTotal,
    ...parts,
    authorBoost: stable.authorBoost,
    followedEntityMatches: stable.followedEntityMatches,
    cooldownMultiplier: stable.cooldownMultiplier,
    isExploration: stable.isExploration,
  }, parts);

  stable.lastDiversityBoost = diversityBoost;
  stable.lastResult = result;
  return result;
}

export function applyRecommendationScore(paper, context = {}) {
  const debugScore = scorePaperForRecommendation(paper, context);
  paper._dynamicScore = debugScore.total;
  paper._debugScore = debugScore;
  return paper;
}

export function weightedShuffle(papers, weights = DEFAULT_RECOMMENDATION_WEIGHTS, random = Math.random) {
  const config = mergeRecommendationWeights(weights);
  const pool = [...papers];
  const result = [];

  while (pool.length > 0) {
    let totalWeight = 0;
    const itemWeights = pool.map((paper) => {
      const isExplore = paper._debugScore?.isExploration || paper._type === 'exploration';
      const score = paper._dynamicScore || 0;
      const baseWeight = isExplore ? config.explorationBaseWeight : config.exploitBaseWeight;
      const weight = Math.max(config.minShuffleWeight, score + baseWeight);
      totalWeight += weight;
      return weight;
    });

    if (totalWeight <= 0) {
      const index = Math.floor(random() * pool.length);
      result.push(pool[index]);
      pool.splice(index, 1);
      continue;
    }

    let cursor = random() * totalWeight;
    let selectedIndex = 0;
    for (let i = 0; i < pool.length; i += 1) {
      cursor -= itemWeights[i];
      if (cursor <= 0) {
        selectedIndex = i;
        break;
      }
    }

    result.push(pool[selectedIndex]);
    pool.splice(selectedIndex, 1);
  }

  return result;
}

function countRecentProperties(papers) {
  const counts = { preprint: 0, published: 0, openAccess: 0, subscription: 0, journal: 0, conference: 0 };

  papers.forEach((paper) => {
    if (paper.publicationStatus === 'preprint' || paper.publicationType === 'preprint') counts.preprint += 1;
    else if (paper.publicationStatus === 'published') counts.published += 1;

    if (paper.openAccess) counts.openAccess += 1;
    else counts.subscription += 1;

    if (paper.sourceType === 'journal' || paper.journal) counts.journal += 1;
    if (paper.sourceType === 'conference' || paper.conference) counts.conference += 1;
  });

  return counts;
}

function getTrailingCategoryRun(papers) {
  const lastCategory = papers.at(-1)?.primaryCategory || '';
  if (!lastCategory) return { lastCategory: '', count: 0 };

  let count = 0;
  for (let index = papers.length - 1; index >= 0; index -= 1) {
    if (papers[index]?.primaryCategory !== lastCategory) break;
    count += 1;
  }
  return { lastCategory, count };
}

export function diversifiedWeightedShuffle(papers, options = {}) {
  const {
    scorePaper,
    weights = DEFAULT_RECOMMENDATION_WEIGHTS,
    initialPapers = [],
    random = Math.random,
    maxConsecutiveCategory = 3,
  } = options;

  const config = mergeRecommendationWeights(weights);
  const pool = [...papers];
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

export function shouldLogRanking() {
  if (typeof window === 'undefined') return false;
  return window.localStorage?.getItem('DEBUG_RANKING') === 'true';
}

export function logRankingBatch(label, papers, limit = 10) {
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
