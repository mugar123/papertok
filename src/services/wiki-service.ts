interface WikiPage { index?: number; title?: string; extract?: string; thumbnail?: { source?: string }; fullurl?: string; pageprops?: { wikibase_item?: string; disambiguation?: unknown } }
interface WikipediaPayload { query?: { pages?: Record<string, WikiPage> } }
interface WikidataSearchPayload { query?: { search?: { title?: string }[]; searchinfo?: { totalhits?: number } } }
interface WikidataPayload { entities?: Record<string, { id?: string; sitelinks?: Record<string, { title?: string }> }> }
interface WikiIds { wikidata?: unknown; wikipedia?: unknown; orcid?: unknown }
interface WikiEntity { id?: string; display_name?: string; ids?: WikiIds; orcid?: unknown; _queryTopic?: boolean; _localTopic?: boolean }
interface WikiIdentity { qid?: string; enwikiTitle?: string; signal?: AbortSignal }
interface WikiOptions { expectedTitle?: string; entity?: WikiEntity | null; title?: string; alternateTitle?: string; signal?: AbortSignal; strictTitleMatch?: boolean }
interface WikiArticle { source: 'wikipedia'; title: string; extract: string; thumbnail: string | null; url: string; language: string; imageSourceUrl?: string }
interface WikiImage { source: 'commons'; thumbnail: string; imageSourceUrl: string }
export type WikiInfo = WikiArticle | WikiImage;

const entityWikiCache = new Map<string, WikiInfo>();

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

function normalizeWikiTitle(value: unknown = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeComparableWikiTitle(value: unknown = '') {
  return normalizeWikiTitle(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function getTopicWikiAlias(value: string|undefined) {
  const comparable = normalizeComparableWikiTitle(value);
  return TOPIC_WIKI_ALIASES.get(comparable)?.['en'] || '';
}

export function mapWikipediaSearchResponse(data: WikipediaPayload | null, {
  expectedTitle = '',
  strictTitleMatch = false,
}: WikiOptions = {}): WikiArticle | null {
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
    source: 'wikipedia',
    title: normalizeWikiTitle(page.title),
    extract: normalizeWikiTitle(page.extract),
    thumbnail: page.thumbnail?.source || null,
    url: page.fullurl || '',
    language: 'en',
  };
}

async function searchWikipedia(title: string, language: string, signal: AbortSignal | undefined, { strictTitleMatch = false } = {}) {
  const normalizedTitle = normalizeWikiTitle(title);
  if (!normalizedTitle) return null;

  const normalizedLanguage = 'en';
  const cacheKey = `${normalizedLanguage}:${strictTitleMatch ? 'strict' : 'fuzzy'}:${normalizedTitle.toLocaleLowerCase('en-US')}`;
  if (entityWikiCache.has(cacheKey)) return entityWikiCache.get(cacheKey)!;
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
const ORCID_PATTERN = /^(?:https?:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i;

/** The ORCID iD behind OpenAlex's `ids.orcid`, a URL or a bare iD. */
export function orcidFromOpenAlexIds(ids: WikiIds | null | undefined) {
  return String(ids?.orcid || '').trim().match(ORCID_PATTERN)?.[1]?.toUpperCase() || '';
}

/**
 * The QID behind OpenAlex's `ids.wikidata`, which comes as a `/wiki/` URL, an
 * `/entity/` URL or a bare `Q…` depending on the entity type. Anything else is
 * no identity at all.
 */
export function wikidataIdFromOpenAlexIds(ids: WikiIds | null | undefined) {
  const raw = String(ids?.wikidata || '').trim();
  if (WIKIDATA_ID_PATTERN.test(raw)) return raw;
  return raw.match(WIKIDATA_URL_PATTERN)?.[1]?.toUpperCase() || '';
}

function enwikiTitleFromUrl(value: unknown) {
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
export function resolveEntityWikiIdentity(entity: WikiEntity | null | undefined) {
  if (!entity || typeof entity !== 'object') return null;
  const qid = wikidataIdFromOpenAlexIds(entity.ids);
  if (qid) return { qid, enwikiTitle: '' };
  const enwikiTitle = enwikiTitleFromUrl(entity.ids?.wikipedia);
  if (enwikiTitle) return { qid: '', enwikiTitle };
  return null;
}

async function fetchJson<T>(url: URL, signal: AbortSignal | undefined): Promise<T | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  return response.json();
}

async function fetchWikidataSitelinks({ qid, enwikiTitle, signal }: WikiIdentity) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbgetentities');
  if (qid) {
    url.searchParams.set('ids', qid);
  } else {
    url.searchParams.set('sites', 'enwiki');
    url.searchParams.set('titles', enwikiTitle!);
  }
  url.searchParams.set('props', 'sitelinks');
  url.searchParams.set('sitefilter', 'enwiki');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const data = await fetchJson<WikidataPayload>(url, signal);
  const entity = Object.values(data?.entities || {})
    .find(candidate => candidate && !Object.hasOwn(candidate, 'missing') && WIKIDATA_ID_PATTERN.test(candidate.id || ''));
  if (!entity || (qid && entity.id !== qid)) return null;
  const titles = Object.fromEntries(Object.entries(entity.sitelinks || {})
    .map(([site, link]) => [site, normalizeWikiTitle(link?.title)]));
  return { qid: entity.id, titles };
}

/**
 * The one Wikidata item that states this ORCID iD (P496). OpenAlex gives
 * authors no Wikidata id, but an author's ORCID is an identity too; two items
 * claiming it, or none, give nothing rather than a guess.
 */
async function fetchWikidataIdByOrcid(orcid: string, signal: AbortSignal | undefined) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', `haswbstatement:P496=${orcid}`);
  url.searchParams.set('srlimit', '2');
  url.searchParams.set('srprop', '');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  const hits = (await fetchJson<WikidataSearchPayload>(url, signal))?.query?.search || [];
  const qid = hits.length === 1 ? hits[0].title || '' : '';
  return WIKIDATA_ID_PATTERN.test(qid) ? qid : '';
}

async function fetchWikipediaPageByTitle({ title, language, qid, signal }: { title: string; language: string; qid: string | undefined; signal?: AbortSignal }): Promise<WikiArticle | null> {
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

  const data = await fetchJson<WikipediaPayload>(url, signal);
  const page = Object.values(data?.query?.pages || {}).find(candidate => candidate && !Object.hasOwn(candidate, 'missing'));
  // The title came from the item itself, but a page can have been moved or
  // turned into a redirect since: only the item it describes today counts.
  if (!page || page.pageprops?.wikibase_item !== qid) return null;
  if (Object.hasOwn(page.pageprops || {}, 'disambiguation')) return null;
  const extract = normalizeWikiTitle(page.extract);
  if (!extract) return null;
  return {
    source: 'wikipedia',
    title: normalizeWikiTitle(page.title),
    extract,
    thumbnail: page.thumbnail?.source || null,
    url: page.fullurl || '',
    language,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function fetchWikidataImage(qid: string, signal?: AbortSignal): Promise<WikiImage | null> {
  const deadline = AbortSignal.timeout(5_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const claimsUrl = new URL('https://www.wikidata.org/w/api.php');
  claimsUrl.search = new URLSearchParams({ action: 'wbgetclaims', entity: qid, property: 'P18', format: 'json', origin: '*' }).toString();
  const response = await fetch(claimsUrl, { signal: requestSignal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Wikidata image lookup failed (${response.status})`);
  const data: unknown = await response.json();
  if (!isRecord(data) || !isRecord(data.claims)) throw new Error('Invalid Wikidata image claims');
  const statements = data.claims.P18;
  if (statements === undefined) return null;
  if (!Array.isArray(statements)) throw new Error('Invalid Wikidata image claims');
  const images = statements.flatMap((statement: unknown) => {
    if (!isRecord(statement) || (statement.rank !== 'preferred' && statement.rank !== 'normal')) return [];
    const snak = statement.mainsnak;
    if (!isRecord(snak) || snak.snaktype !== 'value' || snak.datatype !== 'commonsMedia' || !isRecord(snak.datavalue)) return [];
    const filename = snak.datavalue.value;
    return typeof filename === 'string' && filename.trim() ? [{ rank: statement.rank, filename }] : [];
  });
  const image = images.find(statement => statement.rank === 'preferred') ?? images[0];
  if (!image) return null;
  const { filename } = image;

  const fileUrl = new URL('https://commons.wikimedia.org/w/api.php');
  fileUrl.search = new URLSearchParams({ action: 'query', titles: `File:${filename}`, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '480', format: 'json', origin: '*' }).toString();
  const fileResponse = await fetch(fileUrl, { signal: requestSignal });
  if (fileResponse.status === 404) return null;
  if (!fileResponse.ok) throw new Error(`Commons image lookup failed (${fileResponse.status})`);
  const file: unknown = await fileResponse.json();
  if (!isRecord(file) || !isRecord(file.query) || !isRecord(file.query.pages)) throw new Error('Invalid Commons image metadata');
  const page = Object.values(file.query.pages).find(candidate => isRecord(candidate) && !Object.hasOwn(candidate, 'missing'));
  if (!isRecord(page) || !Array.isArray(page.imageinfo) || !isRecord(page.imageinfo[0])) return null;
  const thumbnail = page.imageinfo[0].thumburl;
  if (typeof thumbnail !== 'string') return null;
  const imageUrl = new URL(thumbnail);
  if (imageUrl.protocol !== 'https:' || imageUrl.hostname !== 'upload.wikimedia.org' || imageUrl.username || imageUrl.password) return null;
  return { source: 'commons', thumbnail: imageUrl.href, imageSourceUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename)}` };
}

/**
 * Wikimedia text and images for a verified identity. A Commons image does not
 * imply that an English Wikipedia biography exists.
 */
export async function getEntityWikiInfoByIdentity({ qid = '', enwikiTitle = '', signal }: WikiIdentity = {}): Promise<WikiInfo | null> {
  const normalizedTitle = normalizeWikiTitle(enwikiTitle);
  if (!qid && !normalizedTitle) return null;

  const cacheKey = `identity:en:${qid || `enwiki:${normalizedTitle}`}`;
  if (entityWikiCache.has(cacheKey)) return entityWikiCache.get(cacheKey)!;

  const item = await fetchWikidataSitelinks({ qid, enwikiTitle: normalizedTitle, signal });
  if (!item) return null;
  const title = item.titles.enwiki;
  const article = title ? await fetchWikipediaPageByTitle({ title, language: 'en', qid: item.qid, signal }) : null;
  let result: WikiInfo | null = article;
  if (!article?.thumbnail && item.qid) {
    try {
      const image = await fetchWikidataImage(item.qid, signal);
      if (image) result = article ? { ...article, thumbnail: image.thumbnail, imageSourceUrl: image.imageSourceUrl } : image;
    } catch (error) {
      if (signal?.aborted || !article) throw error;
      // Preserve the biography, but let a later visit retry the failed photo lookup.
      return article;
    }
  }
  if (result) entityWikiCache.set(cacheKey, result);
  return result;
}

/**
 * What the Explorer's Wikipedia block loads for an entity. Topics of the
 * app's own taxonomy and free-text topics have no identity to follow and keep
 * the title search (exact-title for free text, as before); every OpenAlex
 * entity is resolved by identity (its Wikidata id or English article, or for
 * an author the Wikidata item stating its ORCID) or shows no Wikipedia block.
 */
export async function loadEntityWikiInfo({ entity, title, alternateTitle = '', signal }: WikiOptions = {}) {
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
  if (identity) return getEntityWikiInfoByIdentity({ ...identity, signal });
  const orcid = orcidFromOpenAlexIds(entity?.ids) || orcidFromOpenAlexIds({ orcid: entity?.orcid });
  const qid = orcid ? await fetchWikidataIdByOrcid(orcid, signal) : '';
  return qid ? getEntityWikiInfoByIdentity({ qid, signal }) : null;
}

export async function getEntityWikiInfo({
  title,
  alternateTitle = '',
  signal,
  strictTitleMatch = false,
}: WikiOptions = {}) {
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
