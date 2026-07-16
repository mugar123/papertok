import { getCategoryLabel } from '../data/categories.js';
import { getPaperCategorySignals, scorePaperForRecommendation } from './recommendationEngine.js';
import { buildTrendMomentumLookup } from './reportTrendMath.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function publicationAgeDays(paper, currentDate = new Date()) {
  const rawDate = paper?.publishedDate || paper?.published;
  const timestamp = rawDate ? Date.parse(rawDate) : Number.NaN;
  if (!Number.isFinite(timestamp)) return 1;
  return Math.max(1, Math.ceil(Math.max(0, currentDate.getTime() - timestamp) / DAY_MS));
}

function normalizePercentile(value) {
  if (!Number.isFinite(value)) return null;
  return clamp(value > 1 ? value / 100 : value);
}

function getTopicEntries(paper) {
  const entries = [paper?.primaryTopic, ...(paper?.topics || []), ...(paper?.concepts || [])]
    .filter(Boolean);
  const seen = new Set();
  return entries.filter(entry => {
    const key = typeof entry === 'string' ? entry : entry.id || entry.display_name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTopicMomentum(paper, trendLookup) {
  if (!trendLookup?.size) return 0;
  return getTopicEntries(paper).reduce((best, entry) => {
    const id = typeof entry === 'string' ? entry : entry.id;
    const label = typeof entry === 'string' ? entry : entry.display_name;
    return Math.max(
      best,
      trendLookup.get(String(id || '').toLowerCase()) || 0,
      trendLookup.get(String(label || '').toLowerCase()) || 0,
    );
  }, 0);
}

function getRecentCitationCount(paper, currentDate) {
  const counts = Array.isArray(paper?.countsByYear) ? paper.countsByYear : [];
  if (counts.length === 0) return null;
  const currentYear = currentDate.getFullYear();
  return counts
    .filter(entry => Number(entry.year) >= currentYear - 1)
    .reduce((sum, entry) => sum + (Number(entry.cited_by_count) || 0), 0);
}

export function calculateScientificImpactSignals(paper, timeframe, trendLookup = new Map(), currentDate = new Date()) {
  const ageDays = publicationAgeDays(paper, currentDate);
  const citations = Math.max(0, Number(paper?.citationCount) || 0);
  const normalizedCitation = normalizePercentile(paper?.citationNormalizedPercentile?.value);
  const fwci = Number(paper?.fwci);
  const normalizedFwci = Number.isFinite(fwci) && fwci >= 0
    ? clamp(Math.log1p(fwci) / Math.log(6))
    : null;
  const fieldImpactParts = [normalizedCitation, normalizedFwci].filter(Number.isFinite);
  const fieldImpact = fieldImpactParts.length > 0
    ? fieldImpactParts.reduce((sum, value) => sum + value, 0) / fieldImpactParts.length
    : 0;

  const recentCitations = getRecentCitationCount(paper, currentDate);
  const citationBasis = recentCitations ?? citations;
  const velocityWindowDays = recentCitations === null ? ageDays : Math.min(ageDays, 730);
  const monthlyVelocity = citationBasis / Math.max(1, velocityWindowDays) * 30;
  const citationVelocity = clamp(Math.log1p(monthlyVelocity) / Math.log(26));

  const institutionCount = Math.max(
    0,
    Number(paper?.institutionCount) || 0,
    Array.isArray(paper?.countryCodes) ? paper.countryCodes.length : 0,
  );
  const collaboration = clamp(Math.log1p(institutionCount) / Math.log(9));
  const topicMomentum = getTopicMomentum(paper, trendLookup);
  const abstract = String(paper?.abstract || '').trim();
  const metadataQuality = (
    (abstract.length >= 150 ? 1 : 0)
    + (getTopicEntries(paper).length > 0 ? 1 : 0)
    + (paper?.doi || paper?.arxivId ? 1 : 0)
  ) / 3;

  const windowDays = typeof timeframe === 'string'
    ? { '24h': 2, '7d': 7, '30d': 30, '1y': 365, '10y': 3650 }[timeframe] || 30
    : Math.max(1, timeframe?.days || 30);
  const recency = clamp(1 - ((ageDays - 1) / windowDays));
  const isShort = timeframe === '24h' || timeframe === '7d';
  const isMedium = timeframe === '30d';
  const weights = isShort
    ? { fieldImpact: 0.1, citationVelocity: 0.2, topicMomentum: 0.3, collaboration: 0.15, recency: 0.15, metadataQuality: 0.1 }
    : isMedium
      ? { fieldImpact: 0.25, citationVelocity: 0.25, topicMomentum: 0.25, collaboration: 0.1, recency: 0.1, metadataQuality: 0.05 }
      : { fieldImpact: 0.45, citationVelocity: 0.2, topicMomentum: 0.05, collaboration: 0.1, recency: 0.15, metadataQuality: 0.05 };

  const parts = { fieldImpact, citationVelocity, topicMomentum, collaboration, recency, metadataQuality };
  const score = Object.entries(parts).reduce((sum, [key, value]) => sum + value * weights[key], 0) * 20;
  const availableSignals = [
    fieldImpactParts.length > 0,
    citationBasis > 0,
    getTopicEntries(paper).length > 0,
    institutionCount > 0,
    abstract.length >= 150,
  ].filter(Boolean).length;

  return {
    ...parts,
    score,
    confidence: availableSignals >= 4 ? 'high' : availableSignals >= 2 ? 'medium' : 'low',
  };
}

export function scoreScientificPaper(
  paper,
  timeframe,
  seenCategories = new Map(),
  daysThreshold = 30,
  seenSources = new Map(),
  currentDate = new Date(),
  trendLookup = new Map(),
) {
  let score = 0;
  const ageDays = publicationAgeDays(paper, currentDate);
  const citations = Math.max(0, Number(paper?.citationCount) || 0);
  const yearsOld = Math.max(0.05, ageDays / 365);
  const citationsPerYear = citations / yearsOld;

  if (typeof timeframe === 'string') {
    if (timeframe === '24h' || timeframe === '7d') score += Math.log10(citations + 1) * 20;
    else if (timeframe === '30d') score += Math.log10(citations + 1) * 15;
    else if (timeframe === '1y') score += Math.log10(citationsPerYear + 1) * 16;
    else score += Math.log10(citationsPerYear + 1) * 18;
  } else if ((daysThreshold || 30) <= 31) {
    score += Math.log10(citations + 1) * 15;
  } else {
    score += Math.log10(citationsPerYear + 1) * 16;
  }

  const windowDays = typeof timeframe === 'string'
    ? { '24h': 2, '7d': 7, '30d': 30, '1y': 365, '10y': 3650 }[timeframe] || 30
    : (daysThreshold || 30);
  score += Math.max(0, 1 - (ageDays / windowDays)) * 8;

  const abstract = String(paper?.abstract || '').trim();
  if (abstract.length > 100 && !abstract.startsWith('Resumen no disponible') && !abstract.startsWith('No summary')) {
    score += 2;
  }

  if (typeof timeframe === 'string' && (timeframe === '24h' || timeframe === '7d')) {
    const authorCount = paper?.authors?.length || 0;
    if (authorCount >= 10) score += 4;
    else if (authorCount >= 5) score += 2;
    else if (authorCount >= 2) score += 1;

    const source = String(paper?.journal || paper?.publisher || '').toLowerCase();
    if (source && !['arxiv', 'biorxiv', 'medrxiv'].includes(source)) score += 3;
    if (abstract.length < 150) score -= 5;
    else if (abstract.length > 600) score += 1;
  }

  score += calculateScientificImpactSignals(paper, timeframe, trendLookup, currentDate).score;

  const category = (paper?.categories && paper.categories[0]) || paper?.primaryCategory || '';
  const prefix = String(category).split('.')[0].split('-')[0].toLowerCase();
  if (prefix) score -= (seenCategories.get(prefix) || 0) * 6;

  const source = String(paper?.journal || paper?.publisher || '').toLowerCase().trim();
  if (source) score -= (seenSources.get(source) || 0) * 4;
  return score;
}

export function extractFeaturedConcepts(papers, limit = 5) {
  const conceptScores = new Map();

  (papers || []).forEach((paper, paperIndex) => {
    const concepts = paper?.topics?.length
      ? paper.topics
      : Array.isArray(paper?.concepts) && paper.concepts.length > 0
        ? paper.concepts
        : (paper?.categories || []);
    const seenInPaper = new Set();

    concepts
      .filter(concept => typeof concept !== 'object' || concept?.level !== 0)
      .slice(0, 6)
      .forEach((concept, conceptIndex) => {
        const rawName = typeof concept === 'string' ? concept : concept?.display_name;
        const name = rawName?.trim();
        if (!name || name.length <= 3) return;

        const label = getCategoryLabel(name);
        const normalizedLabel = label.toLocaleLowerCase('es');
        if (seenInPaper.has(normalizedLabel)) return;
        seenInPaper.add(normalizedLabel);

        const relevance = typeof concept?.score === 'number' ? Math.max(0.1, concept.score) : 1;
        const positionWeight = 1 / (1 + conceptIndex * 0.2);
        const selectionWeight = 1 / (1 + paperIndex * 0.05);
        conceptScores.set(label, (conceptScores.get(label) || 0) + relevance * positionWeight * selectionWeight);
      });
  });

  return Array.from(conceptScores.entries())
    .sort(([labelA, scoreA], [labelB, scoreB]) => scoreB - scoreA || labelA.localeCompare(labelB, 'es'))
    .map(([label]) => label)
    .slice(0, limit);
}

function percentileRanks(rows, field) {
  const sorted = [...rows].sort((a, b) => a[field] - b[field]);
  if (sorted.length <= 1) return new Map(sorted.map(row => [row.paper.id, 0.5]));
  return new Map(sorted.map((row, index) => [row.paper.id, index / (sorted.length - 1)]));
}

function profileHasSignals(profile) {
  return Boolean(
    profile?.userPreferences?.length
    || profile?.followedAuthors?.length
    || Object.keys(profile?.categoryAffinities || {}).length
    || Object.keys(profile?.conceptAffinities || {}).length
  );
}

function isInterestMatch(paper, profile) {
  const preferences = new Set(profile?.userPreferences || []);
  const positiveCategories = new Set([
    ...preferences,
    ...Object.entries(profile?.categoryAffinities || {})
      .filter(([, value]) => value > 0)
      .map(([category]) => category),
  ]);
  const categoryMatch = getPaperCategorySignals(paper).some(category => {
    if (positiveCategories.has(category)) return true;
    const area = category.split('.')[0].split('-')[0];
    return [...positiveCategories].some(interest => interest === area || interest.startsWith(`${area}.`));
  });
  const followed = new Set(profile?.followedAuthors || []);
  const authorMatch = paper?.authors?.some(author => followed.has(author?.name || author));
  const conceptMatch = getTopicEntries(paper).some(topic => {
    const id = typeof topic === 'string' ? topic : topic.id;
    return (profile?.conceptAffinities?.[id] || 0) > 0;
  });
  return categoryMatch || authorMatch || conceptMatch;
}

function personalScore(paper, profile, currentDate) {
  const recommendationPaper = paper.openAlex
    ? paper
    : {
        ...paper,
        openAlex: {
          concepts: paper.concepts || paper.topics || [],
          cited_by_count: paper.citationCount || 0,
        },
      };
  const breakdown = scorePaperForRecommendation(recommendationPaper, {
    ...profile,
    now: currentDate.getTime(),
  });
  return breakdown.preference
    + breakdown.affinity
    + breakdown.semantic
    + breakdown.authorBoost
    + breakdown.recency * 0.2;
}

function selectRows(rows, mode, profile, maxToSelect) {
  const editorialRanks = percentileRanks(rows, 'editorialScore');
  const personalRanks = percentileRanks(rows, 'personalScore');
  const remaining = [...rows];
  const selected = [];
  const seenCategories = new Map();
  const seenSources = new Map();
  const readIds = new Set(profile?.readPaperIds || []);

  while (selected.length < maxToSelect && remaining.length > 0) {
    remaining.sort((a, b) => {
      const scoreFor = row => {
        const editorial = editorialRanks.get(row.paper.id) || 0;
        const personal = personalRanks.get(row.paper.id) || 0;
        const base = mode === 'personal' ? editorial * 0.65 + personal * 0.35 : editorial;
        const category = getPaperCategorySignals(row.paper)[0] || '';
        const source = String(row.paper.journal || row.paper.publisher || '').toLowerCase().trim();
        const diversityPenalty = (seenCategories.get(category) || 0) * 0.08
          + (seenSources.get(source) || 0) * 0.05;
        const readPenalty = mode === 'personal' && readIds.has(row.paper.id) ? 0.08 : 0;
        return base - diversityPenalty - readPenalty;
      };
      return scoreFor(b) - scoreFor(a);
    });

    const best = remaining.shift();
    selected.push(best);
    const category = getPaperCategorySignals(best.paper)[0] || '';
    const source = String(best.paper.journal || best.paper.publisher || '').toLowerCase().trim();
    if (category) seenCategories.set(category, (seenCategories.get(category) || 0) + 1);
    if (source) seenSources.set(source, (seenSources.get(source) || 0) + 1);
  }

  if (mode === 'personal' && profileHasSignals(profile)) {
    const explorationCount = selected.filter(row => !isInterestMatch(row.paper, profile)).length;
    const replacementsNeeded = Math.max(0, Math.min(2, maxToSelect) - explorationCount);
    const selectedIds = new Set(selected.map(row => row.paper.id));
    const explorationPool = rows
      .filter(row => !selectedIds.has(row.paper.id) && !isInterestMatch(row.paper, profile))
      .sort((a, b) => b.editorialScore - a.editorialScore);

    let replaced = 0;
    for (let index = selected.length - 1; index >= 1 && replaced < replacementsNeeded; index -= 1) {
      if (!isInterestMatch(selected[index].paper, profile)) continue;
      const replacement = explorationPool.shift();
      if (!replacement) break;
      selected[index] = replacement;
      replaced += 1;
    }
  }

  return selected;
}

function editionFromRows(rows, personalized) {
  const papers = rows.map(row => ({
    ...row.paper,
    reportSignals: row.signals,
  }));
  return {
    mainDiscovery: papers[0] || null,
    highlights: papers.slice(1, 11),
    featuredConcepts: extractFeaturedConcepts(papers),
    personalized,
  };
}

export function buildScientificReportEditions(candidates, options = {}) {
  const currentDate = options.currentDate instanceof Date ? options.currentDate : new Date(options.currentDate || Date.now());
  const trendLookup = buildTrendMomentumLookup(options.trends);
  const profile = options.profile || {};
  const excludedIds = new Set(profile.notInterestedIds || []);
  const filtered = (candidates || []).filter(paper => paper?.id && !excludedIds.has(paper.id));
  const rows = filtered.map(paper => ({
    paper,
    signals: calculateScientificImpactSignals(paper, options.timeframe, trendLookup, currentDate),
    editorialScore: scoreScientificPaper(
      paper,
      options.timeframe,
      new Map(),
      options.days,
      new Map(),
      currentDate,
      trendLookup,
    ),
    personalScore: personalScore(paper, profile, currentDate),
  }));
  const maxToSelect = Math.min(options.limit || 11, rows.length);
  const panoramaRows = selectRows(rows, 'panorama', profile, maxToSelect);
  const hasPersonalization = profileHasSignals(profile);
  const personalRows = hasPersonalization
    ? selectRows(rows, 'personal', profile, maxToSelect)
    : panoramaRows;

  return {
    panorama: editionFromRows(panoramaRows, false),
    personal: editionFromRows(personalRows, hasPersonalization),
  };
}
