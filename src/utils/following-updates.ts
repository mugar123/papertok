import type { Paper, PaperFollowMatch } from '../models/paper.ts';

import { isPlaceholderAuthorName } from '../services/paper-builder.ts';

const MAX_SEEN_IDS = 500;

function normalizeDoi(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
}

function normalizeTitle(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeAuthor(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getFollowingUpdateIdentityKeys(paper: Partial<Paper> = {}) {
  const stableKey = getFollowingUpdatePaperKey(paper);
  const firstAuthor = Array.isArray(paper.authors) ? paper.authors[0] : null;
  const givenName = typeof firstAuthor === 'string' ? firstAuthor : firstAuthor?.name;
  // A placeholder for a missing name names nobody, so it joins no two works.
  const authorName = isPlaceholderAuthorName(givenName) ? '' : normalizeAuthor(givenName);
  const title = normalizeTitle(paper.title);
  const workKey = title && authorName ? `work:${title}|${authorName}` : '';
  return [...new Set([stableKey, workKey].filter(Boolean))];
}

export function getFollowingUpdatePaperKey(paper: Partial<Paper> = {}) {
  const doi = normalizeDoi(paper.doi);
  if (doi) return `doi:${doi}`;
  if (paper.arxivId) return `arxiv:${String(paper.arxivId).trim().toLowerCase()}`;
  if (paper.pmid) return `pmid:${paper.pmid}`;
  if (paper.id) return `id:${String(paper.id).trim().toLowerCase()}`;
  return `title:${normalizeTitle(paper.title)}`;
}

export function getPaperPublicationTime(paper: Partial<Paper> = {}) {
  const value = paper.published || paper.publishedDate || (paper.year ? `${paper.year}-01-01` : '');
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function isRecentFollowingUpdate(paper: Partial<Paper>, now = Date.now(), maxAgeDays = 365) {
  const publicationTime = getPaperPublicationTime(paper);
  if (!publicationTime) return true;
  return publicationTime >= now - maxAgeDays * 24 * 60 * 60 * 1000;
}

function mergeMatches(left: NonNullable<Paper['_followedEntityMatches']> = [], right: NonNullable<Paper['_followedEntityMatches']> = []) {
  const matches = [...left, ...right];
  return matches.filter((match, index) => matches.findIndex(candidate => (
    (candidate as PaperFollowMatch).type === (match as PaperFollowMatch).type && (candidate as PaperFollowMatch).canonicalId === (match as PaperFollowMatch).canonicalId
  )) === index);
}

function mergeFollowingUpdatePaperRecords(current: Paper, paper: Paper, updateKey: string): Paper {
  // The longer abstract, with the source a card credits for it.
  const text = current.abstract?.length >= (paper.abstract?.length || 0) ? current : paper;
  const merged: Paper = {
    ...current,
    ...paper,
    id: current.id || paper.id,
    doi: current.doi || paper.doi,
    arxivId: current.arxivId || paper.arxivId,
    pmid: current.pmid || paper.pmid,
    abstract: text.abstract,
    citationCount: Math.max(current.citationCount || 0, paper.citationCount || 0),
    citationCountKnown: Boolean(current.citationCountKnown || paper.citationCountKnown),
    _followedEntityMatches: mergeMatches(current._followedEntityMatches, paper._followedEntityMatches),
    updateKey,
  };
  if (text.abstractSource) merged.abstractSource = text.abstractSource;
  else delete merged.abstractSource;
  return merged;
}

export function mergeFollowingUpdatePapers(papers: Paper[] = [], limit = 60) {
  const mergedByIdentity = new Map<string, Paper>();

  papers.filter(Boolean).forEach((paper) => {
    const identityKeys = getFollowingUpdateIdentityKeys(paper);
    const existingRecords = [...new Set(identityKeys
      .map(key => mergedByIdentity.get(key))
      .filter(Boolean))] as Paper[];
    if (!existingRecords.length) {
      const next = { ...paper, updateKey: getFollowingUpdatePaperKey(paper) };
      identityKeys.forEach(key => mergedByIdentity.set(key, next));
      return;
    }

    const updateKey = existingRecords[0].updateKey || getFollowingUpdatePaperKey(existingRecords[0]);
    const next = existingRecords.reduce(
      (merged, current) => mergeFollowingUpdatePaperRecords(current, merged, updateKey),
      paper,
    );
    const existingSet = new Set(existingRecords);
    mergedByIdentity.forEach((value, key) => {
      if (existingSet.has(value)) mergedByIdentity.set(key, next);
    });
    identityKeys.forEach(key => mergedByIdentity.set(key, next));
  });

  return [...new Set(mergedByIdentity.values())]
    .sort((a, b) => (
      getPaperPublicationTime(b) - getPaperPublicationTime(a)
      || (b.citationCount || 0) - (a.citationCount || 0)
    ))
    .slice(0, limit);
}

export function compactSeenIds(ids: string[] = []) {
  return [...new Set(ids.filter(Boolean))].slice(-MAX_SEEN_IDS);
}

export function getFollowingUpdatesStorageKey(userId: unknown) {
  return `papertok_following_updates_${String(userId || 'anonymous').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Whether the stored Following result can stand in for a refresh: saved for
 * the same follows within `ttlMs`, with every follow answered. A result in
 * which some follows failed is still shown, but the next load asks again
 * instead of keeping the gap for the whole window (ENG-110).
 */
export function isFollowingCacheFresh(
  stored: { signature?: string; savedAt?: string; meta?: { failedEntities?: number } },
  signature: string,
  ttlMs: number,
  now = Date.now(),
) {
  if (stored.signature !== signature || (stored.meta?.failedEntities ?? 0) > 0) return false;
  return now - Date.parse(stored.savedAt || '') < ttlMs;
}

function getFollowKey(follow: Pick<PaperFollowMatch, 'type' | 'canonicalId'>) {
  return `${follow.type}:${follow.canonicalId}`;
}

export function getFollowingSignature(follows: PaperFollowMatch[] = []) {
  return follows.map(getFollowKey).sort().join('|');
}

/**
 * The papers that match one of `follows`. An unfollow takes off the cards it
 * alone brought in at once, instead of when the next refresh answers (ENG-110).
 */
export function keepPapersOfFollows(papers: Paper[], follows: PaperFollowMatch[]) {
  const followed = new Set(follows.map(getFollowKey));
  return papers.filter(paper => paper._followedEntityMatches?.some(match => (
    typeof match === 'object' && followed.has(getFollowKey(match))
  )));
}

/**
 * Whether a Following request still answers for the account and the follows
 * on screen. A response that arrives after the reader switched accounts or
 * changed their follows is dropped: it would put back the papers of a follow
 * just removed and store them as the cache of the old follows (ENG-110).
 */
export function isCurrentFollowingRequest(
  current: { userId: string | null; signature: string },
  request: { userId: string | null; signature: string },
) {
  return current.userId === request.userId && current.signature === request.signature;
}
