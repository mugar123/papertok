export const DEFAULT_RECOMMENDATION_WEIGHTS = Object.freeze({
  selectedCategory: 100,
  relatedSelectedCategory: 80,
  followedAuthor: 50,
  maxRecency: 5,
  recencyHalfLifeDays: 7,
  classicCitationMultiplier: 5,
  semanticConceptMultiplier: 20,
  citationMultiplier: 5,
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

export function scorePaperForRecommendation(paper, context = {}) {
  const weights = mergeRecommendationWeights(context.weights);
  const now = context.now || Date.now();
  const userPreferences = context.userPreferences || [];
  const followedAuthors = context.followedAuthors || [];
  const categoryAffinities = context.categoryAffinities || {};
  const categoryCooldowns = context.categoryCooldowns || {};
  const conceptAffinities = context.conceptAffinities || {};
  const temporalPreference = context.temporalPreference || 0;

  const primaryCategory = paper.primaryCategory || '';
  const allCategories = paper.allCategories || [];
  const isExploration = paper._debugScore?.isExploration || paper._type === 'exploration';
  const recentPropsCount = context.recentPropsCount || { preprint: 0, published: 0, openAccess: 0, subscription: 0, journal: 0, conference: 0 };

  const affinity = primaryCategory ? categoryAffinities[primaryCategory] || 0 : 0;

  let preference = 0;
  if (primaryCategory && userPreferences.includes(primaryCategory)) {
    preference = weights.selectedCategory;
  } else if (allCategories.some((cat) => userPreferences.includes(cat))) {
    preference = weights.relatedSelectedCategory;
  }

  const authorBoost = paper.authors?.some((author) => followedAuthors.includes(author))
    ? weights.followedAuthor
    : 0;

  const ageDays = daysSince(paper.published, now);
  const recency = Math.max(0, weights.maxRecency * Math.exp(-ageDays / weights.recencyHalfLifeDays))
    * (1 + temporalPreference);

  const citedBy = paper.openAlex?.cited_by_count || 0;
  const classicBoost = temporalPreference < 0 && ageDays > 365 && citedBy > 10
    ? Math.abs(temporalPreference) * Math.log10(citedBy) * weights.classicCitationMultiplier
    : 0;

  const semantic = (paper.openAlex?.concepts || []).reduce((sum, concept) => {
    const affinityValue = conceptAffinities[concept.id] || 0;
    return sum + (concept.score || 0) * affinityValue * weights.semanticConceptMultiplier;
  }, 0);

  const citations = citedBy > 0
    ? Math.log10(citedBy + 1) * weights.citationMultiplier
    : 0;

  const graphBoost = paper._isGraphCandidate ? weights.graphCandidate : 0;

  // --- Content Diversity Soft Constraints ---
  let diversityBoost = 0;
  const isPreprint = paper.publicationStatus === 'preprint' || paper.publicationType === 'preprint';
  const isPublished = paper.publicationStatus === 'published';
  const isOA = paper.openAccess;
  const isJournal = paper.sourceType === 'journal' || paper.journal;
  const isConference = paper.sourceType === 'conference' || paper.conference;

  // If the last 5 cards are saturated with one type, boost the opposite type
  if (recentPropsCount.published >= 4 && isPreprint) diversityBoost += 10;
  if (recentPropsCount.preprint >= 4 && isPublished) diversityBoost += 10;
  
  if (recentPropsCount.subscription >= 3 && isOA) diversityBoost += 8;
  if (recentPropsCount.openAccess >= 4 && !isOA) diversityBoost += 5;

  if (recentPropsCount.conference >= 3 && isJournal) diversityBoost += 8;
  if (recentPropsCount.journal >= 4 && isConference) diversityBoost += 5;

  let cooldownMultiplier = 1;
  if (primaryCategory && categoryCooldowns[primaryCategory]) {
    const cooldownAge = daysSince(categoryCooldowns[primaryCategory], now);
    if (cooldownAge < weights.cooldownDays) {
      cooldownMultiplier = weights.minCooldownMultiplier
        + ((1 - weights.minCooldownMultiplier) * (cooldownAge / weights.cooldownDays));
      cooldownMultiplier = clamp(cooldownMultiplier, weights.minCooldownMultiplier, 1);
    }
  }

  const parts = {
    affinity,
    preference,
    recency,
    classicBoost,
    semantic,
    citations,
    graphBoost,
    authorBoost,
    diversityBoost,
  };
  const baseTotal = Object.values(parts).reduce((sum, value) => sum + value, 0);
  const total = baseTotal * cooldownMultiplier;

  return {
    total,
    baseTotal,
    ...parts,
    cooldownMultiplier,
    isExploration,
    explanation: topReasons(parts).join(', ') || 'neutral',
  };
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
