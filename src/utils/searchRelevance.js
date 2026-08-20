// `users` sits second, and being in this list at all is the point: an unknown
// section scores 99 in getSearchSectionOrder, so a section missing from here
// silently sinks to the bottom of every search forever.
//
// Second rather than first because a non-empty users section is not on its own
// evidence that somebody was looking for a person — a two-letter prefix matches
// by accident — and first would put strangers above the literature on every
// search. The cases where the intent IS a person are caught above, by exact
// match and by the @ sigil.
const DEFAULT_SECTION_ORDER = ['papers', 'users', 'topics', 'authors', 'institutions', 'projects'];

export function normalizeSearchText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function scoreSearchMatch(query, values = []) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  let bestScore = 0;

  values.forEach((value) => {
    const normalizedValue = normalizeSearchText(value);
    if (!normalizedValue) return;
    if (normalizedValue === normalizedQuery) {
      bestScore = Math.max(bestScore, 100);
      return;
    }
    if (normalizedValue.startsWith(`${normalizedQuery} `)) {
      bestScore = Math.max(bestScore, 94);
      return;
    }
    if (normalizedValue.includes(normalizedQuery)) {
      bestScore = Math.max(bestScore, 88);
      return;
    }

    const valueTokens = new Set(normalizedValue.split(' ').filter(Boolean));
    const matchedTokens = queryTokens.filter(token => valueTokens.has(token)).length;
    const coverage = matchedTokens / queryTokens.length;
    bestScore = Math.max(bestScore, Math.round(coverage * 70));
  });

  return bestScore;
}

export function filterRelevantSearchResults(
  query,
  results,
  getValues,
  { minimumScore = 55 } = {},
) {
  return (results || [])
    .map(result => ({
      result,
      score: scoreSearchMatch(query, getValues(result)),
    }))
    .filter(match => match.score >= minimumScore)
    .sort((a, b) => b.score - a.score)
    .map(match => match.result);
}

export function resolvePreferredSearchSection({
  query,
  hint,
  sectionValues = {},
}) {
  const availableSections = new Set(
    Object.entries(sectionValues)
      .filter(([, values]) => Array.isArray(values) && values.length > 0)
      .map(([section]) => section),
  );
  if (hint && availableSections.has(hint)) return hint;

  // A leading @ is a statement of intent no scoring can improve on: nobody
  // types "@" looking for a paper. Checked on the raw query, because
  // normalizeSearchText strips the sigil along with every other symbol.
  if (availableSections.has('users') && /^\s*@/.test(String(query || ''))) return 'users';

  const normalizedQuery = normalizeSearchText(query);
  // `users` leads: an exact match on a handle or a display name is the
  // strongest signal available that a person was meant, stronger than a paper
  // whose title happens to be the same words.
  const exactPriority = ['users', 'topics', 'authors', 'institutions', 'projects', 'papers'];
  const exactSection = exactPriority.find(section => (
    availableSections.has(section)
    && sectionValues[section].some(value => normalizeSearchText(value) === normalizedQuery)
  ));
  if (exactSection) return exactSection;

  if (
    availableSections.has('institutions')
    && /\b(university|universidad|college|institute|instituto|hospital|laboratory|laboratorio)\b/.test(normalizedQuery)
  ) {
    return 'institutions';
  }
  if (
    availableSections.has('projects')
    && /\b(project|proyecto|grant|horizon|erc)\b/.test(normalizedQuery)
  ) {
    return 'projects';
  }

  return DEFAULT_SECTION_ORDER.find(section => availableSections.has(section)) || null;
}

export function getSearchSectionOrder(section, preferredSection) {
  if (section === preferredSection) return 1;
  const defaultIndex = DEFAULT_SECTION_ORDER.indexOf(section);
  return defaultIndex === -1 ? 99 : 10 + defaultIndex;
}
