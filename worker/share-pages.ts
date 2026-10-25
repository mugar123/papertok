import type { Paper } from '../src/models/paper.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import type { EntityMetrics } from '../src/services/adapters/open-alex-types.ts';
import type { ShareCardEntity } from './share-card.ts';
import type { WorkerGlobals } from './env.ts';
import type { ShareImage } from '../src/utils/public-navigation.ts';

type EntityType = keyof typeof SCHEMA_TYPES;
type EntityLookup = { provider: 'openalex'; path: string; params?: never }
  | { provider: 'openaire'; params: Record<string, string>; path?: never };
type PaperIdentity = NonNullable<ReturnType<typeof parsePaperKey>>;
type RouteBase = { canonicalPath: string; cacheId: string; invalid?: false };
export type ShareRoute = RouteBase & (
  { kind: 'paper'; key: string; identity: PaperIdentity }
  | { kind: 'list'; shareId: string }
  | { kind: 'entity'; type: EntityType; id: string; params: { name: string; funder: string }; lookup: EntityLookup | null }
);
type InvalidRoute = { kind: string; invalid: true };
interface ShareList { title: string; description?: string; language?: string; papers?: Array<{ title: string; key?: string }> }
interface ShareEntity extends ShareCardEntity { nameOnly?: boolean }
// The fields of an OpenAlex entity a share card prints (ENTITY_SELECT).
interface OpenAlexEntityRecord extends EntityMetrics {
  geo?: { city?: string; country?: string } | null;
  host_organization_name?: string | null;
  subfield?: { display_name?: string } | null;
  image_thumbnail_url?: string | null;
}
interface ShareRecord { paper?: Partial<Paper> & { authors?: string[] }; list?: ShareList; entity?: ShareEntity }
export interface ShareOutcome { found?: boolean; unknown?: boolean; failed?: boolean; record?: ShareRecord }
type ShareCache = Pick<Cache, 'match' | 'put'>;
export interface ShareDependencies {
  loadShell?: () => Promise<string>;
  loadRecord?: (route: ShareRoute) => Promise<ShareOutcome>;
  admit?: (route: ShareRoute) => Promise<boolean>;
  cache?: ShareCache | null;
}
interface ProjectMetadata { acronym?: { $?: unknown }; title?: { $?: unknown } }
export interface OpenAireProjects { response?: { results?: { result?: { metadata?: { 'oaf:entity'?: { 'oaf:project'?: ProjectMetadata } } }[] } } }
export interface ShareProviders {
  openAlex?: (path: string, params: Record<string, string>) => Promise<(OpenAlexWork & OpenAlexEntityRecord & { results?: OpenAlexWork[] }) | null>;
  arxiv?: (id: string) => Promise<string>;
  openAire?: (params: Record<string, string>) => Promise<OpenAireProjects | null>;
  firestore?: { getDocument: (path: string) => Promise<{ exists: boolean; data?: { title?: unknown; description?: unknown; language?: unknown; papers?: Partial<Paper>[] } | null } | null> };
}
interface SharePage {
  status: number; language: string; title: string; description: string; image: PreviewImage;
  ogType: string; canonicalUrl: string | null; pageUrl: string; noIndex: boolean;
  jsonLd: Record<string, unknown> | null; fallbackHtml: string;
  seed: { key: string; paper: Partial<Paper> } | null;
  maxAge: number;
}
// The image a page previews with, as its head names it.
interface PreviewImage { url: string; alt: string; width: number; height: number }
type XmlText = string | { '#text'?: string };
interface ArxivEntry {
  id?: XmlText; title?: XmlText; summary?: XmlText; published?: XmlText; doi?: XmlText; journal_ref?: XmlText;
  author?: { name?: XmlText } | Array<{ name?: XmlText }>;
}

import { XMLParser } from 'fast-xml-parser';
import { usableOpenAlexAbstract } from '../src/utils/open-alex-abstract.ts';
import { plainScientificText } from '../src/utils/plain-scientific-text.ts';
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, shareCardFor } from './share-card.ts';
import {
  DEFAULT_PUBLIC_ORIGIN,
  DEFAULT_SHARE_IMAGE,
  PUBLIC_ENTITY_TYPES,
  encodePaperKey,
  getShareImage,
  getPublicEntityPath,
  getPublicListPath,
  getPublicPaperPath,
  parsePaperKey,
} from '../src/utils/public-navigation.ts';

/**
 * The HTML a crawler gets for a public page (audit 2026-09-23, issue 5).
 *
 * Every page of the app is one static index.html, and no preview bot runs
 * JavaScript: WhatsApp, Twitterbot, facebookexternalhit and Googlebot all
 * received the same 8963 bytes, titled «PaperTok», with og:url and canonical
 * at /feed and an empty #root. Vercel sends those bots here instead
 * (vercel.json), from /paper/… and /public/{list,user,entity}/… to /share/…, and
 * this module answers the same shell with the page's own head (profiles are
 * gone, so a /share/user/… path gets the not-found page): title,
 * description, canonical, og:* and twitter:*, JSON-LD, a static copy of the
 * page inside #root, and for a paper the paper itself as a seed the app
 * paints from (`src/utils/share-seed.ts`).
 *
 * Two caches, deliberately apart. The shell is kept five minutes, because it
 * names the hashed assets of the current deployment and a stale one points at
 * files Vercel no longer serves. What a page says (the record) is kept a day:
 * it costs a provider call, and papers and lists change slowly. The
 * page is composed per request from the two, so a deploy reaches every page in
 * minutes. Pages are English-only; the reader's Accept-Language is not consulted.
 */

export const SHELL_URL = `${DEFAULT_PUBLIC_ORIGIN}/index.html`;
// Where this Worker answers in production, and so where a card is drawn when
// a page is composed without the address it was asked at.
const WORKER_ORIGIN = 'https://api.papertok.app';
const CACHE_ROOT = 'https://papertok.internal/cache/share';
const ROOT_ELEMENT = '<div id="root"></div>';
const NO_INDEX = 'noindex, nofollow';

// Bumped for a kind when its record gains or loses a field, so a record of
// the old shape is looked up again rather than served for a day. Entities
// gained the share card's fields on 2026-10-25.
const RECORD_VERSIONS: Partial<Record<string, string>> = Object.freeze({ entity: 'v2/' });

const SHELL_CACHE_SECONDS = 5 * 60;
const FOUND_CACHE_SECONDS = 24 * 60 * 60;
// Lists are their owners' to take back: a list unpublished, an account
// deleted. Kept a day, the preview outlived that switch by a day
// (privacy.html: "from then on it is no longer served"); kept five minutes and
// served for one more, it reaches crawlers within six.
const OWNED_FOUND_CACHE_SECONDS = 5 * 60;
const OWNED_MAX_AGE_SECONDS = 60;
const OWNED_KINDS = new Set(['list']);
// A missing page can appear (a paper indexed), so its answer is kept an hour
// rather than a day.
const MISSING_CACHE_SECONDS = 60 * 60;
// A failure is remembered as long as the Worker's other degraded answers
// (DEGRADED_CACHE_SECONDS): long enough that a burst of bots is one upstream
// call, short enough that recovery is invisible.
const FAILURE_CACHE_SECONDS = 120;
const PAGE_MAX_AGE_SECONDS = 300;
const FAILURE_MAX_AGE_SECONDS = 60;

const DESCRIPTION_LENGTH = 300;
const MAX_AUTHORS = 50;
const MAX_LIST_PAPERS = 50;
const MIN_ABSTRACT_LENGTH = 40;
const MAX_ENTITY_ID_LENGTH = 240;

const KINDS = new Set(['paper', 'list', 'entity']);
const ENTITY_TYPES = new Set(PUBLIC_ENTITY_TYPES);
const LIST_ID = /^[a-f0-9]{32}$/;

// The shell this answers when papertok.app cannot give its own. It boots no
// app, but a crawler reads its head and its #root the same.
const MINIMAL_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PaperTok</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const WORK_SELECT = [
  'id',
  'doi',
  'ids',
  'title',
  'display_name',
  'abstract_inverted_index',
  'authorships',
  'publication_year',
  'publication_date',
  'type',
  'language',
  'primary_location',
  'best_oa_location',
  'open_access',
].join(',');
// An entity's name, and what its share card prints beside it
// (worker/share-card.ts). OpenAlex refuses a field the type does not have.
const ENTITY_SELECT: Record<string, string> = Object.freeze({
  author: 'id,display_name,works_count,cited_by_count',
  institution: 'id,display_name,works_count,cited_by_count,geo,image_thumbnail_url',
  source: 'id,display_name,works_count,cited_by_count,host_organization_name',
  topic: 'id,display_name,works_count,cited_by_count,subfield',
  concept: 'id,display_name,works_count,cited_by_count',
});

const OPENALEX_ENTITIES = Object.freeze({
  author: { path: 'authors', prefix: 'A' },
  institution: { path: 'institutions', prefix: 'I' },
  source: { path: 'sources', prefix: 'S' },
  topic: { path: 'topics', prefix: 'T' },
  concept: { path: 'concepts', prefix: 'C' },
});

const SCHEMA_TYPES = Object.freeze({
  author: 'Person',
  institution: 'Organization',
  source: 'Periodical',
  project: 'ResearchProject',
  topic: 'DefinedTerm',
  concept: 'DefinedTerm',
});

// The copy mirrors what each page sets for itself once the app runs
// (`usePublicPageMetadata` callers), so a bot and a reader see one page.
const COPY = Object.freeze({
  siteTitle: 'PaperTok — Discover scientific research',
  siteDescription: 'PaperTok is an application for exploring and discovering scientific papers from multiple sources.',
  notFound: {
    paper: 'We could not find this paper',
    list: 'We could not find this list',
    entity: 'We could not find this page',
  },
  notFoundDescription: 'The link may no longer be available or may not be valid.',
  toFeed: 'Go to the PaperTok feed',
  listSuffix: 'PaperTok public list',
  listFallback: 'Explore a public scientific reading list curated on PaperTok.',
  listPapers: 'Papers in this list',
  entityTypes: {
    author: 'Author',
    institution: 'Institution',
    project: 'Research project',
    source: 'Scientific journal',
    concept: 'Research topic',
    topic: 'Research topic',
  },
  nameOnlyAuthor: 'Found by name: these results may mix people who share it.',
});

function entityDescription(name: string) {
  return `Explore scientific papers, citations, and research connected to ${name} on PaperTok.`;
}

// ------------------------------------------------------------ text helpers

const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

export function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character as keyof typeof HTML_ESCAPES]);
}

/**
 * JSON for inside a `<script>` element: nothing in it can close the element
 * or open a comment, and the two line separators JavaScript once refused in a
 * string literal are escaped too.
 */
function scriptJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function isControlCharacter(character: string) {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}

// The marks and overrides that reorder text on screen: from a URL they can
// make a name read as something else.
function isDirectionControl(character: string) {
  const code = character.charCodeAt(0);
  return code === 0x061c || code === 0x200e || code === 0x200f
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function cleanText(value: unknown, limit = 500) {
  if (value === null || value === undefined) return '';
  const text = [...String(value)]
    .map(character => (isControlCharacter(character) || isDirectionControl(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  const whole = space > limit * 0.6 ? cut.slice(0, space) : cut;
  return `${whole.replace(/[\s,.;:]+$/, '')}…`;
}

function authorLine(names: string[], shown: number) {
  return names.length > shown ? `${names.slice(0, shown).join(', ')} et al.` : names.join(', ');
}

function compact<T extends object>(object: T): Partial<T> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => (
    value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)
  ))) as Partial<T>;
}

function httpUrl(value: unknown) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function bareDoi(value: unknown) {
  const doi = cleanText(value, 300)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : '';
}

function pmidOf(value: unknown) {
  const match = cleanText(value, 120).match(/(?:^|\/)(\d{1,10})\/?$/);
  return match ? match[1] : '';
}

function absoluteUrl(path: string) {
  return `${DEFAULT_PUBLIC_ORIGIN}${path}`;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: XmlText | null | undefined) {
  return value && typeof value === 'object' ? value['#text'] : value;
}

// ------------------------------------------------------------------ routes

function cleanRouteId(value: unknown) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_ENTITY_ID_LENGTH) return '';
  return [...text].some(isControlCharacter) ? '' : text;
}

/**
 * What an entity route can be looked up by, or null when all it carries is a
 * name: an author linked by the name on a byline, a PaperTok topic, a search
 * turned into a topic. A name is not an identity (issue 4 of the same audit),
 * so it is never sent to a provider.
 */
function entityLookup(type: EntityType, id: string, params: { funder?: string }): EntityLookup | null {
  if (type === 'project') {
    if (id.includes('::')) return { provider: 'openaire', params: { openaireProjectID: id } };
    if (!/^[\w.\-/]{1,80}$/.test(id)) return null;
    return { provider: 'openaire', params: { grantID: id, ...(params.funder ? { funder: params.funder } : {}) } };
  }
  const entity = OPENALEX_ENTITIES[type];
  const bare = id.replace(/^https?:\/\/(?:api\.)?openalex\.org\/(?:[a-z]+\/)?/i, '');
  if (new RegExp(`^${entity.prefix}\\d{1,12}$`, 'i').test(bare)) {
    return { provider: 'openalex', path: `${entity.path}/${bare.toUpperCase()}` };
  }
  if (type === 'author') {
    const orcid = id.match(/\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/i)?.[1];
    if (orcid) return { provider: 'openalex', path: `authors/orcid:${orcid.toUpperCase()}` };
  }
  if (type === 'institution') {
    const ror = id.match(/^(?:https?:\/\/)?(?:www\.)?ror\.org\/(0[a-z0-9]{8})\/?$/i)?.[1]
      || id.match(/^(0[a-z0-9]{8})$/i)?.[1];
    if (ror) return { provider: 'openalex', path: `institutions/ror:${ror.toLowerCase()}` };
  }
  return null;
}

/**
 * The page a `/share/…` path stands for: its kind, its identity and the
 * public address it will be canonical at. `null` for a path outside
 * `/share/`, and `{ invalid: true }` for one that names no page — refused
 * before anything is fetched.
 */
export function matchShareRoute(url: URL): ShareRoute | InvalidRoute | null {
  const pathname = url.pathname;
  if (!pathname.startsWith('/share/')) return null;
  let segments;
  try {
    segments = pathname.slice('/share/'.length).split('/').map(segment => decodeURIComponent(segment));
  } catch {
    return { kind: 'unknown', invalid: true };
  }
  const [kind, ...rest] = segments;
  const invalid: InvalidRoute = { kind: KINDS.has(kind) ? kind : 'unknown', invalid: true };

  if (kind === 'paper' && rest.length === 1) {
    const identity = parsePaperKey(rest[0]);
    if (!identity) return invalid;
    // The DOI goes into the OpenAlex path with its slashes, and the URL parser
    // resolves a whole `.` or `..` segment into another record's path. No real
    // DOI has one; a dot inside a segment (`10.1234/a..b`) is part of the DOI.
    if (identity.type === 'doi' && identity.value.split('/').some(segment => segment === '.' || segment === '..')) return invalid;
    const canonicalPath = getPublicPaperPath(identity.type, identity.value)!;
    return {
      kind,
      key: rest[0],
      identity,
      canonicalPath,
      cacheId: `paper/${canonicalPath.split('/').pop()}`,
    };
  }
  if (kind === 'list' && rest.length === 1 && LIST_ID.test(rest[0])) {
    return { kind, shareId: rest[0], canonicalPath: getPublicListPath(rest[0])!, cacheId: `list/${rest[0]}` };
  }
  if (kind === 'entity' && rest.length === 2) {
    const type = rest[0].toLowerCase() as EntityType;
    const id = cleanRouteId(rest[1]);
    if (!ENTITY_TYPES.has(type) || !id) return invalid;
    const params = {
      name: cleanText(url.searchParams.get('name'), 200),
      funder: cleanText(url.searchParams.get('funder'), 80),
    };
    const lookup = entityLookup(type, id, params);
    const funderKey = lookup?.params?.funder ? `?funder=${encodeURIComponent(lookup.params.funder)}` : '';
    return {
      kind,
      type,
      id,
      params,
      lookup,
      canonicalPath: getPublicEntityPath(type, id)!,
      cacheId: `entity/${type}/${encodeURIComponent(id)}${funderKey}`,
    };
  }
  return invalid;
}

// ----------------------------------------------------------------- records

const ARXIV_XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const notFound = (): ShareOutcome => ({ found: false });
// Not found by a provider whose silence proves nothing: OpenAlex indexes a DOI
// or a PMID days after it appears.
const unknown = (): ShareOutcome => ({ found: false, unknown: true });
const found = (record: ShareRecord): ShareOutcome => ({ found: true, record });

function paperFromOpenAlex(work: OpenAlexWork, identity: PaperIdentity) {
  const title = cleanText(work.title || work.display_name, 1000);
  if (!title) return null;
  const doi = bareDoi(work.doi) || (identity.type === 'doi' ? identity.value : '');
  return {
    title,
    abstract: usableOpenAlexAbstract(work),
    authors: asArray(work.authorships)
      .map(authorship => cleanText(authorship?.author?.display_name || authorship?.raw_author_name, 160))
      .filter(Boolean)
      .slice(0, MAX_AUTHORS),
    year: Number.isInteger(work.publication_year) ? work.publication_year : null,
    published: /^\d{4}-\d{2}-\d{2}$/.test(work.publication_date || '') ? work.publication_date : '',
    doi,
    arxivId: identity.type === 'arxiv' ? identity.value : '',
    pmid: pmidOf(work.ids?.pmid) || (identity.type === 'pmid' ? identity.value : ''),
    journal: cleanText(work.primary_location?.source?.display_name, 300),
    landingPageUrl: httpUrl(work.primary_location?.landing_page_url) || (doi ? `https://doi.org/${doi}` : ''),
    pdfUrl: httpUrl(work.best_oa_location?.pdf_url) || httpUrl(work.open_access?.oa_url),
    // OpenAlex's own detection, when it gives one; unknown stays unknown.
    language: /^[a-z]{2}$/.test(work.language || '') ? work.language : '',
  };
}

function paperFromArxivFeed(xml: unknown, requestedId: string) {
  const text = String(xml || '');
  if (!text.includes('<feed')) throw new Error('arXiv answered something that is not a feed');
  const entry = asArray((ARXIV_XML.parse(text) as { feed?: { entry?: ArxivEntry | ArxivEntry[] } })?.feed?.entry)
    .find(candidate => /arxiv\.org\/abs\//i.test(String(textOf(candidate?.id) || '')));
  if (!entry) return null;
  const title = cleanText(textOf(entry.title), 1000);
  if (!title) return null;
  const abstract = cleanText(textOf(entry.summary), 6000);
  const published = String(textOf(entry.published) || '').slice(0, 10);
  const bare = requestedId.replace(/v\d+$/i, '');
  return {
    title,
    abstract: abstract.length >= MIN_ABSTRACT_LENGTH ? abstract : '',
    authors: asArray(entry.author)
      .map(author => cleanText(textOf(author?.name), 160))
      .filter(Boolean)
      .slice(0, MAX_AUTHORS),
    year: /^\d{4}-\d{2}-\d{2}$/.test(published) ? Number(published.slice(0, 4)) : null,
    published: /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : '',
    doi: bareDoi(textOf(entry.doi)),
    arxivId: requestedId,
    pmid: '',
    journal: cleanText(textOf(entry.journal_ref), 300),
    landingPageUrl: `https://arxiv.org/abs/${bare}`,
    pdfUrl: `https://arxiv.org/pdf/${bare}`,
    // arXiv takes its abstracts in English.
    language: 'en',
  };
}

async function loadPaper(route: Extract<ShareRoute, { kind: 'paper' }>, { openAlex, arxiv }: ShareProviders) {
  const { type, value } = route.identity;
  if (type === 'arxiv') {
    const bare = value.replace(/v\d+$/i, '');
    // OpenAlex first, by the landing page, as the app's own fallback asks it;
    // it has no arXiv id field. A preprint from the last days is not in
    // OpenAlex by any route (2609.28470, measured 2026-09-24), and those are
    // most of what the feed shows, so arXiv answers for them.
    const page = await openAlex!('works', {
      filter: `locations.landing_page_url:http://arxiv.org/abs/${bare}|https://arxiv.org/abs/${bare}`,
      'per-page': '1',
      select: WORK_SELECT,
    });
    const work = asArray(page?.results)[0];
    const fromOpenAlex = work?.id ? paperFromOpenAlex(work, route.identity) : null;
    if (fromOpenAlex) return found({ paper: fromOpenAlex });
    const fromArxiv = paperFromArxivFeed(await arxiv!(value), value);
    return fromArxiv ? found({ paper: fromArxiv }) : notFound();
  }
  const path = type === 'doi'
    ? `works/doi:${encodeURIComponent(value).replace(/%2F/gi, '/')}`
    : type === 'openalex' ? `works/${value}` : `works/pmid:${value}`;
  const work = await openAlex!(path, { select: WORK_SELECT });
  const paper = work?.id ? paperFromOpenAlex(work, route.identity) : null;
  if (paper) return found({ paper });
  // An OpenAlex work id OpenAlex does not have is final. A DOI or a PMID it
  // has not indexed yet is most fresh PubMed papers, and «not found» is what
  // a platform would then keep as the preview.
  return type === 'openalex' ? notFound() : unknown();
}

async function loadList(route: Extract<ShareRoute, { kind: 'list' }>, { firestore }: ShareProviders) {
  const document = await firestore!.getDocument(`publicLists/${route.shareId}`);
  if (!document?.exists) return notFound();
  const data = document.data || {};
  const title = cleanText(data.title, 200);
  if (!title) return notFound();
  const papers = asArray(data.papers)
    .slice(0, MAX_LIST_PAPERS)
    .map(paper => ({ title: cleanText(paper?.title, 500), key: encodePaperKey(paper) || '' }))
    .filter(paper => paper.title);
  return found({
    list: {
      title,
      description: cleanText(data.description, 600),
      // Recorded when the list was published; a list without it is not marked.
      language: data.language === 'en' || data.language === 'es' ? data.language : '',
      papers,
    },
  });
}

function projectName(project: ProjectMetadata | undefined) {
  const acronym = cleanText(project?.acronym?.$, 120);
  const title = cleanText(project?.title?.$, 400);
  return acronym && title ? `${acronym}: ${title}` : acronym || title;
}

// What an entity's card says under its name: where an institution is, a
// journal's publisher, a topic's subfield. Not where an author works: OpenAlex
// infers its last known institution from the latest paper, and a card would
// print that guess as a fact.
function entityCardFields(type: EntityType, data: OpenAlexEntityRecord): Omit<ShareCardEntity, 'name'> {
  const subtitle = {
    institution: () => [data.geo?.city, data.geo?.country].map(part => cleanText(part, 80)).filter(Boolean).join(', '),
    source: () => data.host_organization_name,
    topic: () => data.subfield?.display_name,
  }[type as 'institution' | 'source' | 'topic']?.();
  return {
    worksCount: typeof data.works_count === 'number' ? data.works_count : null,
    citedByCount: typeof data.cited_by_count === 'number' ? data.cited_by_count : null,
    subtitle: cleanText(subtitle, 120),
    imageUrl: cleanText(data.image_thumbnail_url, 500),
  };
}

async function loadEntity(route: Extract<ShareRoute, { kind: 'entity' }>, { openAlex, openAire }: ShareProviders) {
  if (!route.lookup) {
    return found({ entity: { name: route.params.name || cleanText(route.id, 200), nameOnly: true } });
  }
  if (route.lookup.provider === 'openaire') {
    const data = await openAire!(route.lookup.params);
    const result = asArray(data?.response?.results?.result)[0];
    const name = projectName(result?.metadata?.['oaf:entity']?.['oaf:project']);
    return name ? found({ entity: { name } }) : notFound();
  }
  const data = await openAlex!(route.lookup.path, { select: ENTITY_SELECT[route.type] });
  const name = cleanText(data?.display_name, 300);
  if (!data?.id || !name) return notFound();
  return found({ entity: { name, ...entityCardFields(route.type, data) } });
}

/**
 * The record behind a page, from the providers the Worker already pays for.
 * `{ found: false }` is an answer — the page does not exist — and a throw is
 * a failure, which the handler keeps apart from it.
 *
 * `providers`, all injected so the Worker owns the budgets:
 * - `openAlex(path, params)` → the JSON, or null for a 404;
 * - `arxiv(id)` → the Atom feed `id_list=id` answers;
 * - `openAire(params)` → the JSON of `search/projects`;
 * - `firestore.getDocument(path)` → `{ exists, id, data }`, read anonymously
 *   so the rules decide exactly as they do for a visitor.
 */
export function createShareLoader(providers: ShareProviders = {}) {
  return async function loadShareRecord(route: ShareRoute | InvalidRoute | null) {
    if (!route || route.invalid) return notFound();
    if (route.kind === 'paper') return loadPaper(route, providers);
    if (route.kind === 'list') return loadList(route, providers);
    if (route.kind === 'entity') return loadEntity(route, providers);
    return notFound();
  };
}

// ------------------------------------------------------------------- pages

// Every share page is English: PaperTok is English-only.
const PAGE_LANGUAGE = 'en';

// The static previews in public/og/ are drawn at 2400x1260.
function staticImage({ path, alt }: ShareImage): PreviewImage {
  return { url: absoluteUrl(path), alt, width: 2400, height: 1260 };
}

function basePage(overrides: Partial<SharePage> = {}): SharePage {
  return {
    status: 200,
    language: PAGE_LANGUAGE,
    title: COPY.siteTitle,
    description: COPY.siteDescription,
    image: staticImage(DEFAULT_SHARE_IMAGE),
    ogType: 'website',
    canonicalUrl: null,
    pageUrl: `${DEFAULT_PUBLIC_ORIGIN}/`,
    noIndex: false,
    jsonLd: null,
    fallbackHtml: '',
    seed: null,
    maxAge: PAGE_MAX_AGE_SECONDS,
    ...overrides,
  };
}

function webPage({ name, description, url, image = staticImage(DEFAULT_SHARE_IMAGE), extra = {} }: { name: string; description: string; url: string; image?: PreviewImage; extra?: Record<string, unknown> }) {
  return compact({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name,
    description,
    url,
    image: image.url,
    inLanguage: 'en-US',
    isPartOf: { '@type': 'WebSite', name: 'PaperTok', url: `${DEFAULT_PUBLIC_ORIGIN}/` },
    ...extra,
  });
}

function notFoundPage(kind: string) {
  const heading = (COPY.notFound[kind as keyof typeof COPY.notFound] || COPY.notFound.entity);
  const description = COPY.notFoundDescription;
  return basePage({
    status: 404,
    title: `${heading} | PaperTok`,
    description,
    noIndex: true,
    jsonLd: webPage({ name: heading, description, url: `${DEFAULT_PUBLIC_ORIGIN}/` }),
    fallbackHtml: `<main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(description)}</p>`
      + `<p><a href="/feed">${escapeHtml(COPY.toFeed)}</a></p></main>`,
  });
}

// What a page says while its provider is down: PaperTok's own head, at the
// page's own address. Not a 404, and not `noindex` — an outage is not a reason
// for a preview to show nothing or for an index to drop the page.
function unavailablePage(route: ShareRoute, maxAge = FAILURE_MAX_AGE_SECONDS) {
  const pageUrl = absoluteUrl(route.canonicalPath);
  return basePage({
    canonicalUrl: pageUrl,
    pageUrl,
    maxAge,
    jsonLd: webPage({ name: COPY.siteTitle, description: COPY.siteDescription, url: pageUrl }),
  });
}

function paperPage(route: Extract<ShareRoute, { kind: 'paper' }>, paper: NonNullable<ShareRecord['paper']>) {
  const pageUrl = absoluteUrl(route.canonicalPath);
  const title = plainScientificText(paper.title) || COPY.siteTitle;
  const abstract = plainScientificText(paper.abstract);
  const authors = asArray(paper.authors);
  const venue = [paper.journal, paper.year].filter(Boolean).join(' · ');
  const description = abstract
    ? truncate(abstract, DESCRIPTION_LENGTH)
    : [authorLine(authors, 3), venue].filter(Boolean).join(' · ') || COPY.siteDescription;
  const doiUrl = paper.doi ? `https://doi.org/${paper.doi}` : '';
  const arxivUrl = paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId.replace(/v\d+$/i, '')}` : '';
  const links = [
    doiUrl && { href: doiUrl, label: `DOI: ${paper.doi}` },
    arxivUrl && { href: arxivUrl, label: `arXiv: ${paper.arxivId}` },
    !doiUrl && !arxivUrl && paper.landingPageUrl && { href: paper.landingPageUrl, label: paper.landingPageUrl },
  ].filter(Boolean) as Array<{ href: string; label: string }>;

  const jsonLd = compact({
    '@context': 'https://schema.org',
    '@type': 'ScholarlyArticle',
    headline: truncate(title, 110),
    name: title,
    description,
    url: pageUrl,
    image: absoluteUrl(DEFAULT_SHARE_IMAGE.path),
    datePublished: paper.published || (paper.year ? String(paper.year) : ''),
    author: authors.slice(0, 20).map(name => ({ '@type': 'Person', name })),
    isPartOf: paper.journal ? { '@type': 'Periodical', name: paper.journal } : null,
    identifier: paper.doi ? { '@type': 'PropertyValue', propertyID: 'DOI', value: paper.doi } : null,
    sameAs: [doiUrl, arxivUrl].filter(Boolean),
    inLanguage: paper.language,
  });

  const article = [
    `<h1>${escapeHtml(title)}</h1>`,
    authors.length ? `<p>${escapeHtml(authorLine(authors, 12))}</p>` : '',
    venue ? `<p>${escapeHtml(venue)}</p>` : '',
    abstract ? `<p>${escapeHtml(abstract)}</p>` : '',
    links.length
      ? `<p>${links.map(link => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join(' · ')}</p>`
      : '',
  ].join('');

  return basePage({
    title,
    description,
    ogType: 'article',
    canonicalUrl: pageUrl,
    pageUrl,
    jsonLd,
    fallbackHtml: `<main><article${paper.language ? ` lang="${escapeHtml(paper.language)}"` : ''}>${article}</article></main>`,
    // The paper as the providers gave it, LaTeX and all: the card renders the
    // math itself. `key` is the address it was asked for, which is what the
    // page matches it against before painting it.
    seed: {
      key: route.key,
      paper: compact({
        id: `${route.identity.type}:${route.identity.value}`,
        title: paper.title,
        abstract: paper.abstract,
        authors: authors.map(name => ({ name })),
        year: paper.year,
        published: paper.published,
        doi: paper.doi,
        arxivId: paper.arxivId,
        pmid: paper.pmid,
        journal: paper.journal,
        landingPageUrl: paper.landingPageUrl,
        pdfUrl: paper.pdfUrl,
      }),
    },
  });
}

function listPage(route: Extract<ShareRoute, { kind: 'list' }>, list: ShareList) {
  const pageUrl = absoluteUrl(route.canonicalPath);
  const description = list.description || COPY.listFallback;
  const papers = asArray(list.papers).map(paper => ({
    title: plainScientificText(paper.title),
    path: paper.key ? getPublicPaperPath(paper.key) : null,
  }));
  const items = papers.map(paper => (paper.path
    ? `<li><a href="${paper.path}">${escapeHtml(paper.title)}</a></li>`
    : `<li>${escapeHtml(paper.title)}</li>`)).join('');
  // The list's own content language (its owner's title and description) is data:
  // a list recorded as written in Spanish is marked `lang="es"` inside the English page.
  const contentLanguage = list.language && list.language !== PAGE_LANGUAGE ? ` lang="${list.language}"` : '';

  const image = staticImage(getShareImage('list'));
  return basePage({
    title: `${list.title} | ${COPY.listSuffix}`,
    description,
    image,
    maxAge: OWNED_MAX_AGE_SECONDS,
    canonicalUrl: pageUrl,
    pageUrl,
    jsonLd: webPage({
      name: list.title,
      description,
      url: pageUrl,
      image,
      extra: {
        '@type': 'CollectionPage',
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: papers.length,
          itemListElement: papers.map((paper, index) => compact({
            '@type': 'ListItem',
            position: index + 1,
            name: paper.title,
            url: paper.path ? absoluteUrl(paper.path) : '',
          })),
        },
      },
    }),
    fallbackHtml: `<main${contentLanguage}><h1>${escapeHtml(list.title)}</h1>`
      + (list.description ? `<p>${escapeHtml(list.description)}</p>` : '')
      + (items ? `<h2>${escapeHtml(COPY.listPapers)}</h2><ol>${items}</ol>` : '')
      + '</main>',
  });
}

/**
 * The entity's own card (`/share/image/…`, worker/share-image.ts) when it can
 * be drawn, or its type's static preview. `cardOrigin` is the Worker's own.
 */
function entityImage(route: Extract<ShareRoute, { kind: 'entity' }>, entity: ShareEntity, cardOrigin: string): PreviewImage {
  const card = entityShareCard(route, entity);
  if (!card) return staticImage(getShareImage(route.type));
  return { url: `${cardOrigin}${shareCardPath(route)}`, alt: card.alt, width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT };
}

/**
 * What an entity's card says, or null when it has none: a page found by a name
 * alone keeps PaperTok's own preview (see `entityPage`), and so does a name
 * the card's fonts cannot draw.
 */
export function entityShareCard(route: Extract<ShareRoute, { kind: 'entity' }>, entity: ShareEntity) {
  return entity.nameOnly ? null : shareCardFor(route.type, COPY.entityTypes[route.type], entity);
}

/** Where an entity's card is drawn: the page's own record, under /share/image/. */
export function shareCardPath(route: Extract<ShareRoute, { kind: 'entity' }>) {
  return `/share/image/${route.cacheId}`;
}

function entityPage(route: Extract<ShareRoute, { kind: 'entity' }>, entity: ShareEntity, cardOrigin: string) {
  const pageUrl = absoluteUrl(route.canonicalPath);
  const typeLabel = COPY.entityTypes[route.type];
  if (entity.nameOnly) {
    // A page found by a name alone is not an entity, and its name is whatever
    // the URL says: printed in the preview, it let anyone mint a papertok.app
    // card that says anything under our name and image (review of
    // 2026-09-25). The preview is PaperTok's own; the page's copy names whom
    // it was opened for, as the Explorer does, and it stays out of an index,
    // since the same name can be several people.
    const note = route.type === 'author' ? `<p>${escapeHtml(COPY.nameOnlyAuthor)}</p>` : '';
    return basePage({
      canonicalUrl: pageUrl,
      pageUrl,
      noIndex: true,
      jsonLd: webPage({ name: COPY.siteTitle, description: COPY.siteDescription, url: pageUrl }),
      fallbackHtml: `<main><h1>${escapeHtml(entity.name)}</h1><p>${escapeHtml(typeLabel)}</p>${note}</main>`,
    });
  }
  const description = entityDescription(entity.name);
  const image = entityImage(route, entity, cardOrigin);
  return basePage({
    title: `${entity.name} - ${typeLabel} | PaperTok`,
    description,
    image,
    ogType: 'profile',
    canonicalUrl: pageUrl,
    pageUrl,
    jsonLd: webPage({
      name: `${entity.name} - ${typeLabel}`,
      description,
      url: pageUrl,
      image,
      extra: { about: { '@type': SCHEMA_TYPES[route.type], name: entity.name } },
    }),
    fallbackHtml: `<main><h1>${escapeHtml(entity.name)}</h1><p>${escapeHtml(typeLabel)}</p>`
      + `<p>${escapeHtml(description)}</p></main>`,
  });
}

/**
 * The page for a route and what its lookup gave: `{ found, record }`,
 * `{ found: false }`, or `{ failed: true }`.
 */
export function sharePageModel(route: ShareRoute | InvalidRoute | null, outcome: ShareOutcome | null, language?: string, options?: { cardOrigin?: string }): SharePage;
export function sharePageModel(route: ShareRoute | InvalidRoute | null, outcome: ShareOutcome | null, _language?: string, { cardOrigin = WORKER_ORIGIN }: { cardOrigin?: string } = {}) {
  const kind = KINDS.has(route?.kind as string) ? route!.kind : 'entity';
  if (!route || route.invalid || !outcome || (!outcome.found && !outcome.failed && !outcome.unknown)) {
    return notFoundPage(kind);
  }
  // Not found by a provider whose silence proves nothing: PaperTok's own head,
  // as for an outage, and no index directive either way.
  if (outcome.unknown) return unavailablePage(route, PAGE_MAX_AGE_SECONDS);
  const record = outcome.record || {};
  if (outcome.found && route.kind === 'paper' && record.paper) return paperPage(route, record.paper);
  if (outcome.found && route.kind === 'list' && record.list) return listPage(route, record.list);
  if (outcome.found && route.kind === 'entity' && record.entity) return entityPage(route, record.entity, cardOrigin);
  return unavailablePage(route);
}

// --------------------------------------------------------------- rendering

const TITLE_TAG = /<title>[\s\S]*?<\/title>/i;
const CANONICAL_TAG = /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i;
const JSON_LD_TAG = /<script\s+id="papertok-jsonld"\s+type="application\/ld\+json">[\s\S]*?<\/script>/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replacements are functions throughout: a string replacement reads `$&`,
// `$1` and `$'` as patterns, and a list's title or description can contain
// any of them.
function setElement(html: string, pattern: RegExp, element: string | null) {
  if (pattern.test(html)) return html.replace(pattern, () => element || '');
  if (!element) return html;
  return html.replace(/<\/head>/i, () => `  ${element}\n  </head>`);
}

function setMeta(html: string, attribute: string, key: string, value: unknown) {
  const pattern = new RegExp(`<meta\\s+${attribute}="${escapeRegExp(key)}"\\s+content="[^"]*"\\s*\\/?>`, 'i');
  const element = value === null || value === undefined
    ? null
    : `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`;
  return setElement(html, pattern, element);
}

/** The shell with the page's head, its static copy in #root and its seed. */
export function renderSharePage(shell: string, page: SharePage) {
  let html = typeof shell === 'string' && shell.includes(ROOT_ELEMENT) ? shell : MINIMAL_SHELL;
  html = html.replace(/<html\b[^>]*>/i, () => `<html lang="${page.language}">`);
  html = setElement(html, TITLE_TAG, `<title>${escapeHtml(page.title)}</title>`);
  html = setMeta(html, 'name', 'description', page.description);
  html = setMeta(html, 'name', 'robots', page.noIndex ? NO_INDEX : null);
  html = setElement(html, CANONICAL_TAG, page.canonicalUrl
    ? `<link rel="canonical" href="${escapeHtml(page.canonicalUrl)}" />`
    : null);
  html = setMeta(html, 'property', 'og:type', page.ogType);
  html = setMeta(html, 'property', 'og:site_name', 'PaperTok');
  html = setMeta(html, 'property', 'og:title', page.title);
  html = setMeta(html, 'property', 'og:description', page.description);
  html = setMeta(html, 'property', 'og:url', page.pageUrl);
  html = setMeta(html, 'property', 'og:locale', 'en_US');
  // A shell that still advertises an alternate locale loses it: there is none.
  html = setMeta(html, 'property', 'og:locale:alternate', null);
  html = setMeta(html, 'property', 'og:image', page.image.url);
  html = setMeta(html, 'property', 'og:image:alt', page.image.alt);
  html = setMeta(html, 'property', 'og:image:width', String(page.image.width));
  html = setMeta(html, 'property', 'og:image:height', String(page.image.height));
  html = setMeta(html, 'name', 'twitter:card', 'summary_large_image');
  html = setMeta(html, 'name', 'twitter:title', page.title);
  html = setMeta(html, 'name', 'twitter:description', page.description);
  html = setMeta(html, 'name', 'twitter:url', page.pageUrl);
  html = setMeta(html, 'name', 'twitter:image', page.image.url);
  html = setMeta(html, 'name', 'twitter:image:alt', page.image.alt);
  html = setElement(html, JSON_LD_TAG, page.jsonLd
    ? `<script id="papertok-jsonld" type="application/ld+json">${scriptJson(page.jsonLd)}</script>`
    : null);

  const seed = page.seed
    ? `\n    <script type="application/json" id="papertok-share-seed">${scriptJson(page.seed)}</script>`
    : '';
  return html.replace(ROOT_ELEMENT, () => `<div id="root">${page.fallbackHtml || ''}</div>${seed}`);
}

// ------------------------------------------------------------------ caches

async function cachedJson(cache: ShareCache | null | undefined, key: Request) {
  try {
    const hit = await cache?.match(key);
    return hit ? await hit.json<ShareOutcome>() : null;
  } catch {
    return null;
  }
}

async function cachedText(cache: ShareCache | null | undefined, key: Request) {
  try {
    const hit = await cache?.match(key);
    return hit ? await hit.text() : null;
  } catch {
    return null;
  }
}

async function keep(cache: ShareCache | null | undefined, key: Request, body: string, contentType: string, seconds: number) {
  try {
    await cache?.put(key, new Response(body, {
      headers: { 'content-type': contentType, 'cache-control': `public, s-maxage=${seconds}` },
    }));
  } catch {
    // A page that cannot be kept is still a page.
  }
}

/** The deployed app shell, kept five minutes (see the module comment). */
export function createShellLoader({ fetchShell, cache = (globalThis as WorkerGlobals).caches?.default, url = SHELL_URL }: { fetchShell?: (url: string) => Promise<Response>; cache?: ShareCache | null; url?: string } = {}) {
  const key = new Request(`${CACHE_ROOT}/shell`);
  return async function loadShell() {
    const cached = await cachedText(cache, key);
    if (cached) return cached;
    const response = await fetchShell!(url);
    if (!response?.ok) throw new Error(`The app shell answered ${response?.status}`);
    const html = await response.text();
    // A maintenance page or an error document is not dressed up as the app.
    if (!html.includes(ROOT_ELEMENT) || !/<\/head>/i.test(html)) throw new Error('The app shell is not the app');
    await keep(cache, key, html, 'text/html; charset=utf-8', SHELL_CACHE_SECONDS);
    return html;
  };
}

// Lookups in flight in this isolate, by record. A fan-out of crawlers for one
// link — a Mastodon post reaches hundreds of servers at once — used to spend a
// lookup each and run the ceilings dry (review of 2026-09-25).
const lookupsInFlight = new Map<string, Promise<ShareOutcome>>();

export async function readRecord(route: ShareRoute, deps: ShareDependencies) {
  // A page known only by its name costs nothing to answer, and asks nobody.
  if (route.kind === 'entity' && !route.lookup) return deps.loadRecord!(route);
  const key = new Request(`${CACHE_ROOT}/record/${RECORD_VERSIONS[route.kind] || ''}${route.cacheId}`);
  const cached = await cachedJson(deps.cache, key);
  if (cached) return cached;

  const pending = lookupsInFlight.get(route.cacheId);
  if (pending) return pending;
  const lookup = lookUpRecord(route, key, deps);
  lookupsInFlight.set(route.cacheId, lookup);
  try {
    return await lookup;
  } finally {
    lookupsInFlight.delete(route.cacheId);
  }
}

async function lookUpRecord(route: ShareRoute, key: Request, { loadRecord, admit, cache }: ShareDependencies): Promise<ShareOutcome> {
  let admitted = false;
  try {
    admitted = await admit!(route);
  } catch (error) {
    console.warn(`Share page admission failed (${route.kind})`, (error as Error)?.message || error);
  }
  // A refusal is about this minute, not about the page: kept, it answered for
  // the page long after the minute it was true in.
  if (!admitted) return { failed: true };

  let outcome;
  let seconds;
  try {
    const loaded = await loadRecord!(route);
    if (loaded?.found) {
      outcome = { found: true, record: loaded.record };
      seconds = OWNED_KINDS.has(route.kind) ? OWNED_FOUND_CACHE_SECONDS : FOUND_CACHE_SECONDS;
    } else {
      outcome = loaded?.unknown ? { unknown: true } : { found: false };
      seconds = MISSING_CACHE_SECONDS;
    }
  } catch (error) {
    console.warn(`Share page lookup failed (${route.kind})`, (error as Error)?.message || error);
    // Another lookup may have found the page while this one was failing; a
    // failure never takes the place of what it found.
    const current = await cachedJson(cache, key);
    if (current && !current.failed) return current;
    outcome = { failed: true };
    seconds = FAILURE_CACHE_SECONDS;
  }
  await keep(cache, key, JSON.stringify(outcome), 'application/json', seconds);
  return outcome;
}

// The entity's card is drawn by this Worker, at the host it was asked at.
// Only a local Worker is plain http; anywhere else the card is https, the only
// scheme a preview bot is sure to fetch.
function cardOrigin(url: URL) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? url.origin : `https://${url.host}`;
}

/**
 * GET or HEAD `/share/{paper,list,entity}/…`. Public, and without an
 * Origin: the caller is Vercel relaying a crawler (see vercel.json).
 *
 * - `loadShell()` → the app shell (`createShellLoader`);
 * - `loadRecord(route)` → the page's record (`createShareLoader`);
 * - `admit(route)` → whether a lookup may be spent now, asked only on a miss.
 */
export async function handleSharePage(request: Request, {
  loadShell,
  loadRecord,
  admit = async () => true,
  cache = (globalThis as WorkerGlobals).caches?.default,
}: ShareDependencies = {}) {
  const route = matchShareRoute(new URL(request.url));
  const outcome = route && !route.invalid
    ? await readRecord(route, { loadRecord, admit, cache })
    : { found: false };
  const page = sharePageModel(route, outcome, undefined, { cardOrigin: cardOrigin(new URL(request.url)) });

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': `public, max-age=${page.maxAge}`,
    'content-language': page.language,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin',
  });
  if (page.noIndex) headers.set('x-robots-tag', NO_INDEX);
  if (request.method === 'HEAD') return new Response(null, { status: page.status, headers });

  let shell = MINIMAL_SHELL;
  try {
    shell = await loadShell!();
  } catch (error) {
    console.warn('Share page shell unavailable', (error as Error)?.message || error);
  }
  return new Response(renderSharePage(shell, page), { status: page.status, headers });
}
