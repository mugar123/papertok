const entityWikiCache = new Map();

function normalizeWikiTitle(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeComparableWikiTitle(value = '') {
  return normalizeWikiTitle(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

export function mapWikipediaSearchResponse(data, language = 'en', {
  expectedTitle = '',
  strictTitleMatch = false,
} = {}) {
  const pages = Object.values(data?.query?.pages || {})
    .filter(page => page && !Object.hasOwn(page.pageprops || {}, 'disambiguation'))
    .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
  const expected = normalizeComparableWikiTitle(expectedTitle);
  const page = pages.find(candidate => {
    if (!normalizeWikiTitle(candidate.extract)) return false;
    if (!strictTitleMatch || !expected) return true;
    return normalizeComparableWikiTitle(candidate.title) === expected;
  });
  if (!page) return null;

  return {
    title: normalizeWikiTitle(page.title),
    extract: normalizeWikiTitle(page.extract),
    thumbnail: page.thumbnail?.source || null,
    url: page.fullurl || '',
    language: language === 'en' ? 'en' : 'es',
  };
}

async function searchWikipedia(title, language, signal, { strictTitleMatch = false } = {}) {
  const normalizedTitle = normalizeWikiTitle(title);
  if (!normalizedTitle) return null;

  const normalizedLanguage = language === 'en' ? 'en' : 'es';
  const cacheKey = `${normalizedLanguage}:${strictTitleMatch ? 'strict' : 'fuzzy'}:${normalizedTitle.toLocaleLowerCase('en-US')}`;
  if (entityWikiCache.has(cacheKey)) return entityWikiCache.get(cacheKey);

  const url = new URL(`https://${normalizedLanguage}.wikipedia.org/w/api.php`);
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', normalizedTitle);
  url.searchParams.set('gsrnamespace', '0');
  url.searchParams.set('gsrlimit', '3');
  url.searchParams.set('prop', 'extracts|pageimages|info|pageprops');
  url.searchParams.set('exintro', '1');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('piprop', 'thumbnail');
  url.searchParams.set('pithumbsize', '480');
  url.searchParams.set('inprop', 'url');
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const response = await fetch(url, { signal });
  if (!response.ok) return null;

  const result = mapWikipediaSearchResponse(await response.json(), normalizedLanguage, {
    expectedTitle: normalizedTitle,
    strictTitleMatch,
  });
  if (result) entityWikiCache.set(cacheKey, result);
  return result;
}

export async function getEntityWikiInfo({
  title,
  alternateTitle = '',
  language = 'es',
  signal,
  strictTitleMatch = false,
} = {}) {
  const candidates = [...new Set([title, alternateTitle].map(normalizeWikiTitle).filter(Boolean))];
  for (const candidate of candidates) {
    const result = await searchWikipedia(candidate, language, signal, { strictTitleMatch });
    if (result) return result;
  }
  return null;
}

export const getAuthorWikiInfo = async (authorName) => {
  if (!authorName) return null;

  try {
    // Wikipedia API for page summaries (English)
    // We replace spaces with underscores for the title
    const title = encodeURIComponent(authorName.trim().replace(/\s+/g, '_'));
    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return null; // Author doesn't have a Wikipedia page
      }
      throw new Error(`Wikipedia API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Wikipedia returns type="disambiguation" if multiple people share the name
    if (data.type === 'disambiguation') {
      return null;
    }

    // Validate that the person is actually a researcher/scientist
    // to avoid showing actors/politicians who share the same name.
    const textToCheck = `${data.description || ''} ${data.extract || ''}`.toLowerCase();
    const academicKeywords = [
      'scientist', 'researcher', 'professor', 'academic', 'physicist', 
      'chemist', 'biologist', 'mathematician', 'engineer', 'scholar', 
      'astronomer', 'computer', 'science', 'university', 'institute', 
      'doctor', 'phd', 'inventor', 'author', 'research'
    ];

    const isAcademic = academicKeywords.some(keyword => textToCheck.includes(keyword));
    
    if (!isAcademic) {
      return null; // False positive (e.g., football player with same name)
    }

    return {
      title: data.title,
      description: data.description, // e.g., "American computer scientist"
      extract: data.extract, // Text summary
      thumbnail: data.thumbnail?.source || null, // Image URL if available
      pageUrl: data.content_urls?.desktop?.page || null
    };
  } catch (error) {
    console.error('Error fetching Wikipedia info:', error);
    return null;
  }
};
