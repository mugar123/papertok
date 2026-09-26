const entityWikiCache = new Map();

const TOPIC_WIKI_ALIASES = new Map([
  ['black hole', { en: 'Black hole' }],
  ['black holes', { en: 'Black hole' }],
  ['agujero negro', { en: 'Black hole' }],
  ['agujeros negros', { en: 'Black hole' }],
  ['neural networks', { en: 'Neural network' }],
  ['redes neuronales', { en: 'Neural network' }],
  ['gravitational waves', { en: 'Gravitational wave' }],
  ['ondas gravitacionales', { en: 'Gravitational wave' }],
  ['exoplanets', { en: 'Exoplanet' }],
  ['exoplanetas', { en: 'Exoplanet' }],
  ['superconductors', { en: 'Superconductivity' }],
  ['superconductores', { en: 'Superconductivity' }],
  ['large language models', { en: 'Large language model' }],
  ['modelos de lenguaje grandes', { en: 'Large language model' }],
  ['particle accelerators', { en: 'Particle accelerator' }],
  ['aceleradores de particulas', { en: 'Particle accelerator' }],
  ['quantum computers', { en: 'Quantum computing' }],
  ['ordenadores cuanticos', { en: 'Quantum computing' }],
  ['computadoras cuanticas', { en: 'Quantum computing' }],
]);

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

function getTopicWikiAlias(value) {
  const comparable = normalizeComparableWikiTitle(value);
  return TOPIC_WIKI_ALIASES.get(comparable)?.['en'] || '';
}

export function mapWikipediaSearchResponse(data, {
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
    language: 'en',
  };
}

async function searchWikipedia(title, language, signal, { strictTitleMatch = false } = {}) {
  const normalizedTitle = normalizeWikiTitle(title);
  if (!normalizedTitle) return null;

  const normalizedLanguage = 'en';
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

  const result = mapWikipediaSearchResponse(await response.json(), {
    expectedTitle: normalizedTitle,
    strictTitleMatch,
  });
  if (result) entityWikiCache.set(cacheKey, result);
  return result;
}

const WIKIDATA_ID_PATTERN = /^Q[1-9]\d*$/;
const WIKIDATA_URL_PATTERN = /^https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/(Q[1-9]\d*)$/i;
const ENWIKI_URL_PATTERN = /^https?:\/\/en\.wikipedia\.org\/wiki\/([^?#]+)$/i;

/**
 * The QID behind OpenAlex's `ids.wikidata`, which comes as a `/wiki/` URL, an
 * `/entity/` URL or a bare `Q…` depending on the entity type. Anything else is
 * no identity at all.
 */
export function wikidataIdFromOpenAlexIds(ids) {
  const raw = String(ids?.wikidata || '').trim();
  if (WIKIDATA_ID_PATTERN.test(raw)) return raw;
  return raw.match(WIKIDATA_URL_PATTERN)?.[1]?.toUpperCase() || '';
}

function enwikiTitleFromUrl(value) {
  const path = String(value || '').trim().match(ENWIKI_URL_PATTERN)?.[1];
  if (!path) return '';
  try {
    return normalizeWikiTitle(decodeURIComponent(path).replace(/_/g, ' '));
  } catch {
    return '';
  }
}

/**
 * What an OpenAlex entity says it is on Wikipedia: its Wikidata id, or for a
 * topic (which only carries an English article) that article's title. `null`
 * when the entity names neither, and then there is nothing to show: a search
 * by name is exactly what put a cancer researcher's portrait on "Tumor
 * progression" and a Shakira single on "Medicine" (audit of 2026-09-23).
 */
export function resolveEntityWikiIdentity(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const qid = wikidataIdFromOpenAlexIds(entity.ids);
  if (qid) return { qid, enwikiTitle: '' };
  const enwikiTitle = enwikiTitleFromUrl(entity.ids?.wikipedia);
  if (enwikiTitle) return { qid: '', enwikiTitle };
  return null;
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  return response.json();
}

async function fetchWikidataSitelinks({ qid, enwikiTitle, signal }) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbgetentities');
  if (qid) {
    url.searchParams.set('ids', qid);
  } else {
    url.searchParams.set('sites', 'enwiki');
    url.searchParams.set('titles', enwikiTitle);
  }
  url.searchParams.set('props', 'sitelinks');
  url.searchParams.set('sitefilter', 'enwiki');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const data = await fetchJson(url, signal);
  const entity = Object.values(data?.entities || {})
    .find(candidate => candidate && !Object.hasOwn(candidate, 'missing') && WIKIDATA_ID_PATTERN.test(candidate.id || ''));
  if (!entity || (qid && entity.id !== qid)) return null;
  const titles = Object.fromEntries(Object.entries(entity.sitelinks || {})
    .map(([site, link]) => [site, normalizeWikiTitle(link?.title)]));
  return { qid: entity.id, titles };
}

async function fetchWikipediaPageByTitle({ title, language, qid, signal }) {
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', title);
  url.searchParams.set('prop', 'extracts|pageimages|info|pageprops');
  url.searchParams.set('exintro', '1');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('piprop', 'thumbnail');
  url.searchParams.set('pithumbsize', '480');
  url.searchParams.set('inprop', 'url');
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const data = await fetchJson(url, signal);
  const page = Object.values(data?.query?.pages || {}).find(candidate => candidate && !Object.hasOwn(candidate, 'missing'));
  // The title came from the item itself, but a page can have been moved or
  // turned into a redirect since: only the item it describes today counts.
  if (!page || page.pageprops?.wikibase_item !== qid) return null;
  if (Object.hasOwn(page.pageprops || {}, 'disambiguation')) return null;
  const extract = normalizeWikiTitle(page.extract);
  if (!extract) return null;
  return {
    title: normalizeWikiTitle(page.title),
    extract,
    thumbnail: page.thumbnail?.source || null,
    url: page.fullurl || '',
    language,
  };
}

/**
 * The English Wikipedia article of an entity known by identity. Never a search.
 */
export async function getEntityWikiInfoByIdentity({ qid = '', enwikiTitle = '', signal } = {}) {
  const normalizedTitle = normalizeWikiTitle(enwikiTitle);
  if (!qid && !normalizedTitle) return null;

  const cacheKey = `identity:en:${qid || `enwiki:${normalizedTitle}`}`;
  if (entityWikiCache.has(cacheKey)) return entityWikiCache.get(cacheKey);

  const item = await fetchWikidataSitelinks({ qid, enwikiTitle: normalizedTitle, signal });
  if (!item) return null;
  const title = item.titles.enwiki;
  if (!title) return null;

  const result = await fetchWikipediaPageByTitle({ title, language: 'en', qid: item.qid, signal });
  if (result) entityWikiCache.set(cacheKey, result);
  return result;
}

/**
 * What the Explorer's Wikipedia block loads for an entity. Topics of the
 * app's own taxonomy and free-text topics have no identity to follow and keep
 * the title search (exact-title for free text, as before); every OpenAlex
 * entity is resolved by identity or shows no Wikipedia block.
 */
export async function loadEntityWikiInfo({ entity, title, alternateTitle = '', signal } = {}) {
  // No Wikidata id to go by: a search, and only an article by that exact
  // title counts. For the taxonomy's own topics too, since their curated
  // aliases already are titles, and a first hit that is another article is a
  // guess (AGENTS.md, invariant 3; review of 2026-09-25).
  if (entity?._queryTopic || entity?._localTopic) {
    return getEntityWikiInfo({
      title,
      alternateTitle,
      signal,
      strictTitleMatch: true,
    });
  }
  const identity = resolveEntityWikiIdentity(entity);
  if (!identity) return null;
  return getEntityWikiInfoByIdentity({ ...identity, signal });
}

export async function getEntityWikiInfo({
  title,
  alternateTitle = '',
  signal,
  strictTitleMatch = false,
} = {}) {
  const requestedLanguage = 'en';
  const rawCandidates = [title, alternateTitle].map(normalizeWikiTitle).filter(Boolean);
  const candidates = [...new Set([
    ...rawCandidates,
    ...rawCandidates.map(candidate => getTopicWikiAlias(candidate)).filter(Boolean),
  ])];
  for (const candidate of candidates) {
    const result = await searchWikipedia(candidate, requestedLanguage, signal, { strictTitleMatch });
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
