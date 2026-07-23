const MAX_SEEN_IDS = 500;

function normalizeDoi(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function getFollowingUpdatePaperKey(paper = {}) {
  const doi = normalizeDoi(paper.doi);
  if (doi) return `doi:${doi}`;
  if (paper.arxivId) return `arxiv:${String(paper.arxivId).trim().toLowerCase()}`;
  if (paper.pmid) return `pmid:${paper.pmid}`;
  if (paper.id) return `id:${String(paper.id).trim().toLowerCase()}`;
  return `title:${normalizeTitle(paper.title)}`;
}

export function getPaperPublicationTime(paper = {}) {
  const value = paper.published || paper.publishedDate || (paper.year ? `${paper.year}-01-01` : '');
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function isRecentFollowingUpdate(paper, now = Date.now(), maxAgeDays = 365) {
  const publicationTime = getPaperPublicationTime(paper);
  if (!publicationTime) return true;
  return publicationTime >= now - maxAgeDays * 24 * 60 * 60 * 1000;
}

function mergeMatches(left = [], right = []) {
  const matches = [...left, ...right];
  return matches.filter((match, index) => matches.findIndex(candidate => (
    candidate.type === match.type && candidate.canonicalId === match.canonicalId
  )) === index);
}

export function mergeFollowingUpdatePapers(papers = [], limit = 60) {
  const merged = new Map();

  papers.filter(Boolean).forEach((paper) => {
    const key = getFollowingUpdatePaperKey(paper);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...paper, updateKey: key });
      return;
    }

    merged.set(key, {
      ...current,
      ...paper,
      abstract: current.abstract?.length >= (paper.abstract?.length || 0) ? current.abstract : paper.abstract,
      citationCount: Math.max(current.citationCount || 0, paper.citationCount || 0),
      citationCountKnown: Boolean(current.citationCountKnown || paper.citationCountKnown),
      _followedEntityMatches: mergeMatches(current._followedEntityMatches, paper._followedEntityMatches),
      updateKey: key,
    });
  });

  return [...merged.values()]
    .sort((a, b) => (
      getPaperPublicationTime(b) - getPaperPublicationTime(a)
      || (b.citationCount || 0) - (a.citationCount || 0)
    ))
    .slice(0, limit);
}

export function compactSeenIds(ids = []) {
  return [...new Set(ids.filter(Boolean))].slice(-MAX_SEEN_IDS);
}

export function getFollowingUpdatesStorageKey(userId) {
  return `papertok_following_updates_${String(userId || 'anonymous').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

export function getFollowingSignature(follows = []) {
  return follows
    .map(follow => `${follow.type}:${follow.canonicalId}`)
    .sort()
    .join('|');
}
