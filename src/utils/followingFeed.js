import { getFollowingUpdatePaperKey, getPaperPublicationTime } from './followingUpdates.js';
import { resolvePaperTopic } from './topicNavigation.js';
import { getLocalizedInstitutionName } from './institutionLocalization.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_DECAY_DAYS = 120;
const IMMEDIATE_REPEAT_PENALTY = 12;
const MAX_CONSECUTIVE_PER_FOLLOW = 2;

const TYPE_LABELS = {
  es: {
    author: 'a',
    topic: '',
    institution: '',
    project: 'el proyecto',
  },
  en: {
    author: '',
    topic: '',
    institution: '',
    project: 'the project',
  },
};

/**
 * One human sentence explaining why a paper is in the Siguiendo feed.
 * Matches come from followingUpdatesService, which resolves follows through
 * stable identifiers (OpenAlex ids, ROR, project ids) before ever falling back
 * to normalized names, so a match here is a proven relationship.
 *
 * @param {Array<{type: string, displayName: string}>} matches
 * @returns {string}
 */
export function buildFollowReasonLabel(matches = [], language = 'es') {
  const named = matches.filter(match => match?.displayName);
  if (named.length === 0) return '';
  const isEnglish = language === 'en';
  if (named.length > 2) {
    return isEnglish ? 'Matches several things you follow' : 'Coincide con varios de tus seguimientos';
  }

  const parts = named.map((match) => {
    const connector = TYPE_LABELS[isEnglish ? 'en' : 'es'][match.type] ?? '';
    const localizedTopic = match.type === 'topic'
      ? resolvePaperTopic(match.canonicalId, language)
        || resolvePaperTopic(match.displayName, language)
      : null;
    const localizedInstitution = match.type === 'institution'
      ? getLocalizedInstitutionName(match, language)
      : null;
    const displayName = localizedTopic?.label || localizedInstitution || match.displayName;
    return connector ? `${connector} ${displayName}` : displayName;
  });
  return isEnglish
    ? `Because you follow ${parts.join(' and ')}`
    : `Porque sigues ${parts.join(' y ')}`;
}

function getFollowKeys(paper = {}) {
  return [...new Set((paper._followedEntityMatches || [])
    .filter(match => match && typeof match === 'object')
    .map((match) => {
      const id = String(match.canonicalId || '').trim().toLowerCase();
      const name = String(match.displayName || '').trim().toLowerCase();
      return id ? `${match.type || 'follow'}:${id}` : name ? `${match.type || 'follow'}:${name}` : '';
    })
    .filter(Boolean))];
}

function sharesFollow(leftKeys = [], rightKeys = []) {
  if (!leftKeys.length || !rightKeys.length) return false;
  const right = new Set(rightKeys);
  return leftKeys.some(key => right.has(key));
}

function getBlockedFollowKeys(ordered = [], maximum = MAX_CONSECUTIVE_PER_FOLLOW) {
  if (ordered.length < maximum) return new Set();
  const recentKeySets = ordered.slice(-maximum).map(paper => new Set(getFollowKeys(paper)));
  if (recentKeySets.some(keys => keys.size === 0)) return new Set();
  return new Set([...recentKeySets[0]].filter(key => recentKeySets.every(keys => keys.has(key))));
}

function hasBlockedFollow(paper, blockedKeys) {
  return getFollowKeys(paper).some(key => blockedKeys.has(key));
}

/**
 * Scores only papers already proven to belong to a followed entity. Recency is
 * the strongest signal, citations are normalized by age, and matching several
 * follows adds confidence. Seen state is a small novelty boost, not a separate
 * inbox partition.
 */
export function getFollowingFeedRelevanceScore(paper = {}, seenIds = new Set(), now = Date.now()) {
  const publicationTime = getPaperPublicationTime(paper);
  const ageDays = publicationTime
    ? Math.max(0, (Number(now) - publicationTime) / DAY_MS)
    : RECENCY_DECAY_DAYS * 2;
  const recencyScore = publicationTime
    ? 72 * Math.exp(-ageDays / RECENCY_DECAY_DAYS)
    : 0;

  const citations = Math.max(
    0,
    Number(paper.citationCount ?? paper.openAlex?.cited_by_count ?? paper.openAlex?.citationCount) || 0,
  );
  const citationVelocity = citations / Math.max(1, Math.sqrt(ageDays + 1));
  const impactScore = Math.min(26, Math.log1p(citationVelocity) * 8);

  const matchCount = getFollowKeys(paper).length;
  const followScore = matchCount ? Math.min(36, 16 + (matchCount - 1) * 10) : 0;
  const seenSet = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  const noveltyScore = seenSet.has(getFollowingUpdatePaperKey(paper)) ? 0 : 8;

  return recencyScore + impactScore + followScore + noveltyScore;
}

/**
 * Builds one global Siguiendo ranking instead of preserving the five-paper
 * blocks returned by each followed entity. A soft repetition penalty mixes
 * similarly relevant sources, while a hard cap prevents three consecutive
 * papers from the same follow whenever another source is available.
 *
 * @param {Array} items - deduplicated papers from FollowingUpdatesContext
 * @param {Set<string>} seenIds - keys already seen by this user
 * @param {{now?: number, maxConsecutivePerFollow?: number}} options
 * @returns {Array}
 */
export function orderFollowingFeedPapers(items = [], seenIds = new Set(), options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maximum = Math.max(1, Number(options.maxConsecutivePerFollow) || MAX_CONSECUTIVE_PER_FOLLOW);
  const ranked = (items || []).filter(Boolean).map(paper => ({
    paper,
    score: getFollowingFeedRelevanceScore(paper, seenIds, now),
    key: getFollowingUpdatePaperKey(paper),
  })).sort((left, right) => (
    right.score - left.score
    || getPaperPublicationTime(right.paper) - getPaperPublicationTime(left.paper)
    || (right.paper.citationCount || 0) - (left.paper.citationCount || 0)
    || left.key.localeCompare(right.key)
  ));

  const ordered = [];
  while (ranked.length) {
    const blockedKeys = getBlockedFollowKeys(ordered, maximum);
    const hasAlternative = blockedKeys.size > 0
      && ranked.some(candidate => !hasBlockedFollow(candidate.paper, blockedKeys));
    const previousKeys = getFollowKeys(ordered.at(-1));
    let bestIndex = -1;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;

    ranked.forEach((candidate, index) => {
      if (hasAlternative && hasBlockedFollow(candidate.paper, blockedKeys)) return;
      const repeatPenalty = sharesFollow(getFollowKeys(candidate.paper), previousKeys)
        ? IMMEDIATE_REPEAT_PENALTY
        : 0;
      const adjustedScore = candidate.score - repeatPenalty;
      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    });

    const [selected] = ranked.splice(bestIndex >= 0 ? bestIndex : 0, 1);
    ordered.push(selected.paper);
  }
  return ordered;
}

/**
 * A refresh that lands while the feed is on screen must not reshuffle it.
 *
 * The ranking above is run once per visit, from the items the page opened
 * with. When a silent refresh replaces those items a few seconds in, the
 * papers already on screen keep their places — each under its fresh copy, so
 * new citations and matches still reach the card — papers the refresh no
 * longer carries are dropped, and papers it brings for the first time are
 * appended in the fresh ranking's order. A card moving under the thumb read
 * as the feed glitching; the next visit ranks everything again from scratch.
 */
export function mergeOrderedPapers(previousOrdered = [], freshOrdered = []) {
  if (!previousOrdered.length) return freshOrdered;
  const freshByKey = new Map(freshOrdered.map(paper => [getFollowingUpdatePaperKey(paper), paper]));
  const kept = [];
  const keptKeys = new Set();
  previousOrdered.forEach((paper) => {
    const key = getFollowingUpdatePaperKey(paper);
    if (!freshByKey.has(key) || keptKeys.has(key)) return;
    keptKeys.add(key);
    kept.push(freshByKey.get(key));
  });
  const appended = freshOrdered.filter(paper => !keptKeys.has(getFollowingUpdatePaperKey(paper)));
  return [...kept, ...appended];
}

/**
 * Whether the Following feed is still waiting to hear about its papers for
 * the first time — the moment it should show the same discovery screen For
 * You shows, not a skeleton card.
 *
 * Nothing on screen, and either a load in flight or no answer ever recorded
 * (`lastUpdatedAt` is set by the first refresh and by a restored cache, and
 * by the no-follows shortcut, so a reader who follows nothing is not left
 * "discovering" forever). An error is the error screen's to report.
 */
export function followingFirstLoadPending({ items = [], loading = false, lastUpdatedAt = null, error = null } = {}) {
  if (error) return false;
  if ((items || []).length > 0) return false;
  return Boolean(loading) || !lastUpdatedAt;
}

/**
 * The order the Following feed resumes with.
 *
 * Each visit used to rank from scratch, and each visit had a different
 * seen-set — the cards the reader had just scrolled past — so coming back
 * found the cards shuffled and the place the reader had kept in their head
 * gone. The feed the reader left is the feed they come back to: the same
 * items resume in the same order; items a refresh replaced meanwhile keep the
 * places they had (`mergeOrderedPapers`), with what is new appended. A fresh
 * ranking happens once, the first time in a session there is anything to rank.
 *
 * @param {{ items: Array|null, ordered: Array }} previous  what the page left last time
 */
export function resumeOrderedPapers(previous, items = [], seenIds = new Set()) {
  if (previous?.items === items && Array.isArray(previous?.ordered)) return previous.ordered;
  // The order still in memory wins; after a reload of the tab there is none,
  // and the keys the page stored on its way out rebuild it over the items
  // that came back (`orderFromKeys`).
  const kept = previous?.ordered?.length ? previous.ordered : orderFromKeys(items, previous?.orderKeys);
  return mergeOrderedPapers(kept, orderFollowingFeedPapers(items, seenIds));
}

/** The keys of an order, in order — what the page stores so a reload can resume it. */
export function orderKeysOf(ordered = []) {
  return (ordered || []).filter(Boolean).map(getFollowingUpdatePaperKey);
}

/**
 * The items named by a stored key order, in that order; keys the items no
 * longer carry are skipped. A reload of the tab loses the module-scope
 * order but not the items (localStorage) nor these keys (sessionStorage).
 */
export function orderFromKeys(items = [], keys = []) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const byKey = new Map((items || []).filter(Boolean).map(paper => [getFollowingUpdatePaperKey(paper), paper]));
  const taken = new Set();
  return keys.flatMap((key) => {
    const paper = byKey.get(key);
    if (!paper || taken.has(key)) return [];
    taken.add(key);
    return [paper];
  });
}
