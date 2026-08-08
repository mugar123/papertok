const QUERY_TOPIC_MINIMUM_SCORE = 70;

const TOKEN_STOP_WORDS = new Set([
  'and', 'del', 'for', 'las', 'los', 'the', 'una', 'with',
]);

function normalizeQueryText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function semanticLabel(value) {
  if (typeof value === 'string') return value;
  return value?.display_name || value?.displayName || value?.name || value?.label || '';
}

function semanticValues(paper) {
  return [
    ...(paper?.concepts || []),
    ...(paper?.topics || []),
    paper?.primaryTopic,
    ...(paper?.keywords || []),
    ...(paper?.biomedicalTerms || []),
    ...(paper?.categories || []),
  ].map(semanticLabel).map(normalizeQueryText).filter(Boolean);
}

function containsPhrase(value, phrase) {
  return Boolean(value && phrase && ` ${value} `.includes(` ${phrase} `));
}

function queryTokens(query) {
  return [...new Set(query.split(' ').filter(token => (
    token.length >= 2 && !TOKEN_STOP_WORDS.has(token)
  )))];
}

function matchedTokenCount(value, tokens) {
  const values = new Set(value.split(' ').filter(Boolean));
  return tokens.reduce((count, token) => count + (values.has(token) ? 1 : 0), 0);
}

function hasExactCategoryMatch(paper, topic) {
  const categoryIds = new Set((topic?.categoryIds || []).map(normalizeQueryText).filter(Boolean));
  if (categoryIds.size === 0) return false;

  const declaredCategories = (paper?.categories || []).map(normalizeQueryText).filter(Boolean);
  if (declaredCategories.some(category => categoryIds.has(category))) return true;
  return declaredCategories.length === 0 && categoryIds.has(normalizeQueryText(paper?.primaryCategory));
}

export function scoreQueryTopicPaper(paper, topic) {
  const query = normalizeQueryText(topic?.query || topic?.display_name || topic?.label);
  if (!query || !paper) return 0;
  if (hasExactCategoryMatch(paper, topic)) return 140;

  const title = normalizeQueryText(paper.title);
  const semantic = semanticValues(paper);
  const abstract = normalizeQueryText([paper.abstract, paper.summary].filter(Boolean).join(' '));

  if (semantic.some(value => value === query)) return 130;
  if (title === query) return 124;
  if (containsPhrase(title, query)) return 116;
  if (semantic.some(value => containsPhrase(value, query))) return 108;
  if (containsPhrase(abstract, query)) return 88;

  const tokens = queryTokens(query);
  if (tokens.length === 0) return 0;
  const titleMatches = matchedTokenCount(title, tokens);
  const semanticMatches = matchedTokenCount(semantic.join(' '), tokens);
  const abstractMatches = matchedTokenCount(abstract, tokens);

  if (titleMatches === tokens.length) return 80;
  if (semanticMatches === tokens.length) return 76;
  if (abstractMatches === tokens.length) return 58;
  if (tokens.length > 2 && titleMatches / tokens.length >= 0.75) return 68;
  return 0;
}

export function filterRelevantQueryTopicPapers(
  papers,
  topic,
  { minimumScore = QUERY_TOPIC_MINIMUM_SCORE } = {},
) {
  return (papers || [])
    .map((paper, index) => ({ paper, index, score: scoreQueryTopicPaper(paper, topic) }))
    .filter(result => result.score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(result => result.paper);
}
