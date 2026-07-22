function normalizePhrase(value) {
  const withoutControlCharacters = [...String(value || '')]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('');

  return withoutControlCharacters
    .normalize('NFKC')
    .replace(/["\\()[\]{}]/g, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s&+.,:/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function buildScopusSearchQuery({ terms = [], author = '' } = {}) {
  const normalizedAuthor = normalizePhrase(author);
  if (normalizedAuthor) return `AUTH("${normalizedAuthor}")`;

  const normalizedTerms = [...new Set((terms || []).map(normalizePhrase).filter(Boolean))].slice(0, 4);
  return normalizedTerms.map(term => `TITLE-ABS-KEY("${term}")`).join(' OR ');
}
