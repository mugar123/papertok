import type { Paper, PaperAuthor } from '../src/models/paper.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { restsOnArxivDoi } from '../src/services/paper-builder.ts';
import { mergeRankedPapers } from '../src/services/paper-search-merge.ts';
import { OPENALEX_SEARCH_TYPES, OPENALEX_WORK_SEARCH_FIELDS, doiPathId, formatOpenAlexWorkAsPaper, getArxivIdFromWork, mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { getPaperIdentity } from '../src/utils/public-navigation.ts';
import { handleAgentArxiv } from './arxiv-api.ts';
import { readBoundedJson } from './bounded-body.ts';
import { reserveCallerMinute } from './caller-quota.ts';
import { captureWorkerException, captureWorkerResponseFailure } from './error-tracking.ts';
import { allowedOrigins, json } from './http.ts';
import { handleOpenAccess } from './open-access.ts';
import { handleAgentOpenAlex } from './openalex-api.ts';
import { arxivRecordPaper, parseArxivAtom } from './paper-sources.ts';

/**
 * PaperTok as a remote MCP server (ENG-91, phase 1): public, read-only, no
 * account. Streamable HTTP without sessions or server-sent events: every POST
 * carries one JSON-RPC message and gets one JSON answer. The official SDK is
 * not used; this handler covers the four methods phase 1 needs.
 *
 * Every tool asks an existing route in-process, as `paper-sources.ts` does
 * for the harvest, but much as a reader: the route's validation, cache keys,
 * provider budgets and per-address allowances apply as they do to the
 * browser. The caller's `CF-Connecting-IP` travels with each ask, so those
 * allowances count this caller. ENG-91 puts agents in the lowest budget tier:
 * a billed OpenAlex miss spends `exploration` (`handleAgentOpenAlex`), and an
 * arXiv miss takes no seat a reader could book (`handleAgentArxiv`). The
 * citation graph waits for phase 2: the browser's needs an account, and these
 * callers have none.
 */
export const MCP_PATH = '/mcp';

// Newest first: an unknown version asked for in `initialize` gets the first.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
// When a client sends no `MCP-Protocol-Version`, the transport says to assume this one.
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 16 * 1024;
// Tool calls one address may make in a UTC minute, cache hits included. The
// routes behind them keep their own per-address limits on misses.
const MCP_CALLER_MINUTE = Object.freeze({ namespace: 'mcp', limit: 30 });
const MAX_RESULTS = 10;
const DEFAULT_SEARCH_LIMIT = 5;
// A client reads a tool result up to a ceiling (Claude Code's default is about
// 25,000 tokens), and the payload travels twice, as text and as structured
// content. One paper of a large collaboration lists thousands of authors and
// hundreds of institutions, so each list a paper carries is cut, and the paper
// says how many entries each cut left out. A paper asked for alone keeps more
// of its authors: a hundred are about 7 KB.
const MAX_AUTHORS = 20;
const MAX_PAPER_AUTHORS = 100;
const MAX_INSTITUTIONS = 10;
const MAX_SUBJECTS = 5;
const MAX_TOPICS = 3;
const MAX_OA_LOCATIONS = 5;
// An abstract runs up to 6,000 characters (`usableOpenAlexAbstract`). A search
// sends its first 1,500, and `get_paper` the whole of it.
const MAX_SEARCH_ABSTRACT = 1_500;
// Even cut, ten papers of large collaborations come to about 70 KB. A search
// sends papers in rank order while they fit in this many bytes of JSON, which
// keeps its text block under 40 KB, and counts the rest in `omitted.papers`.
const SEARCH_BUDGET_BYTES = 36_000;
const PAPER_BOUNDS = Object.freeze({ maxAuthors: MAX_PAPER_AUTHORS, maxAbstract: Infinity });

const SERVER_INFO = Object.freeze({ name: 'papertok', title: 'PaperTok', version: '1.0.0' });
const INSTRUCTIONS = 'Read-only access to scholarly papers as PaperTok normalizes them. Results carry abstracts and metadata, never full text. citationCount is given only where citationCountKnown is true. A field a paper lacks, such as its abstract, review status or open-access status, is unknown, not empty, zero or false.';

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const PAPER_ID_SCHEMA = { type: 'string', description: 'A DOI (10.xxxx/...), arXiv id (2401.01234), OpenAlex work id (W123...) or PubMed id (pmid:123). URLs and doi:/arxiv: prefixes are accepted.' };
const DOI_SCHEMA = { type: 'string', description: 'The DOI, with or without https://doi.org/.' };

const TOOLS = [
  {
    name: 'search_papers',
    title: 'Search papers',
    description: `Searches OpenAlex and arXiv and merges records of the same paper by DOI or arXiv id. A paper has its openalex:W… id when OpenAlex found it, else its arXiv id, and arXiv categories when arXiv found it, else OpenAlex concept names, or topic names for a work without concepts. Returns at most ${MAX_RESULTS} papers in PaperTok's paper format, with abstracts cut at ${MAX_SEARCH_ABSTRACT} characters (get_paper returns the whole abstract), author lists at ${MAX_AUTHORS} names, institutions at ${MAX_INSTITUTIONS}, concepts and category names at ${MAX_SUBJECTS}, and topics at ${MAX_TOPICS}; a paper's "omitted" counts the entries each cut list left out, and the characters for the abstract. Papers of very large collaborations can return fewer papers than the limit; the result's "omitted.papers" counts those left out. A source that is unavailable or over its budget is listed in "unavailable".`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 300, description: 'Search words.' },
        sources: { type: 'array', items: { type: 'string', enum: ['openalex', 'arxiv'] }, minItems: 1, uniqueItems: true, description: 'Defaults to both. Case does not matter.' },
        since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Only papers published or submitted on or after this date (YYYY-MM-DD).' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, default: DEFAULT_SEARCH_LIMIT },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_paper',
    title: 'Get a paper',
    description: `Looks one paper up by DOI, arXiv id, OpenAlex work id or PubMed id (pmid:123) and returns it in PaperTok's paper format (abstract and metadata, not full text). An arXiv id is looked up on arXiv, or on OpenAlex when arXiv is busy or failing, and any other id on OpenAlex. An OpenAlex answer has an openalex:W… id and concept names in categories, and arXiv's the arXiv id and arXiv categories, so a search result can come back with another id or other categories. Authors are cut at ${MAX_PAPER_AUTHORS} names, institutions at ${MAX_INSTITUTIONS}, concepts and category names at ${MAX_SUBJECTS}, and topics at ${MAX_TOPICS}; "omitted" counts the entries each cut list left out.`,
    inputSchema: { type: 'object', properties: { id: PAPER_ID_SCHEMA }, required: ['id'], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'find_open_access',
    title: 'Find open access',
    description: `Finds legal open-access copies of a paper by DOI (Unpaywall, then Crossref licences): whether one exists, the best location, its licence and version, and up to ${MAX_OA_LOCATIONS} locations ("omitted" counts the rest). "is_oa": null means it is unknown.`,
    inputSchema: { type: 'object', properties: { doi: DOI_SCHEMA }, required: ['doi'], additionalProperties: false },
    annotations: READ_ONLY,
  },
] as const;

type ToolName = typeof TOOLS[number]['name'];
type Arguments = Record<string, unknown>;
type RpcId = string | number;
type RouteHandler = (request: Request, env: WorkerEnv) => Promise<Response>;

class InvalidArguments extends Error {}

class ToolFailure extends Error {
  details: Record<string, unknown>;
  constructor(details: Record<string, unknown> & { code: string }) {
    super(details.code);
    this.details = details;
  }
}

function rpcResult(id: RpcId, result: unknown) {
  return json({ jsonrpc: '2.0', id, result }, 200, { 'cache-control': 'no-store' });
}

function rpcError(id: RpcId | null, code: number, message: string, status = 200) {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status, { 'cache-control': 'no-store' });
}

function toolResult(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

// ─── Arguments, checked before anything is reserved or asked ───

function onlyKeys(args: Arguments, allowed: string[]) {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));
  if (unknown.length) throw new InvalidArguments(`Unknown argument: ${unknown[0]}`);
}

function integerArgument(value: unknown, fallback: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_RESULTS) {
    throw new InvalidArguments(`${name} must be an integer from 1 to ${MAX_RESULTS}`);
  }
  return value as number;
}

function paperIdentity(value: unknown) {
  if (typeof value !== 'string' || value.length > 300) return null;
  const identity = getPaperIdentity(value.trim(), undefined);
  const separator = identity.indexOf(':');
  return separator > 0 ? { type: identity.slice(0, separator), value: identity.slice(separator + 1) } : null;
}

function doiArgument(value: unknown) {
  const identity = paperIdentity(value);
  if (identity?.type !== 'doi') throw new InvalidArguments('doi must be a DOI such as 10.1234/abcd');
  return identity.value;
}

function searchArguments(args: Arguments) {
  onlyKeys(args, ['query', 'sources', 'since', 'limit']);
  const query = typeof args.query === 'string' ? args.query.trim().replace(/\s+/g, ' ') : '';
  if (query.length < 2 || query.length > 300 || !/[\p{L}\p{N}]/u.test(query)) {
    throw new InvalidArguments('query must be 2 to 300 characters with a letter or digit');
  }
  // Read in any case: a model writes the providers' own "OpenAlex" and "arXiv".
  const sources = args.sources === undefined ? ['openalex', 'arxiv']
    : Array.isArray(args.sources) ? args.sources.map(source => (typeof source === 'string' ? source.toLowerCase() : source))
      : args.sources;
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length
    || sources.some(source => source !== 'openalex' && source !== 'arxiv')) {
    throw new InvalidArguments('sources must list "openalex" and/or "arxiv" once each');
  }
  let since = '';
  if (args.since !== undefined) {
    const valid = typeof args.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.since)
      && !Number.isNaN(Date.parse(args.since)) && new Date(args.since).toISOString().startsWith(args.since);
    if (!valid) throw new InvalidArguments('since must be a date as YYYY-MM-DD');
    since = args.since as string;
  }
  return { query, sources: sources as string[], since, limit: integerArgument(args.limit, DEFAULT_SEARCH_LIMIT, 'limit') };
}

// ─── Asking the routes ───

async function ask(handler: RouteHandler, path: string, params: Record<string, string | number>, caller: Request, env: WorkerEnv) {
  const url = new URL(`https://papertok.internal${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== '') url.searchParams.set(name, String(value));
  }
  const headers = new Headers();
  const address = caller.headers.get('cf-connecting-ip');
  if (address) headers.set('cf-connecting-ip', address);
  let response: Response;
  try {
    response = await handler(new Request(url, { headers }), env);
  } catch (error) {
    // A route throws when its provider failed; the router turns that into a
    // 429, 502 or 504 and reports it, and so does this, as a tool error.
    captureWorkerException(error);
    const { name, status, retryAfter } = error as UpstreamError;
    if (status === 429) throw new ToolFailure({ code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: Number(retryAfter) || 60 });
    throw new ToolFailure({ code: name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', ...(status ? { upstreamStatus: status } : {}) });
  }
  if (response.ok) return response;
  if (response.status === 404) throw new ToolFailure({ code: 'NOT_FOUND' });
  // The route's own validation, or the provider's, refused what was asked:
  // an identifier the relay cannot carry, or a search the provider rejects.
  if (response.status === 400) throw new ToolFailure({ code: 'INVALID_ARGUMENTS', message: 'The source refused this request as invalid' });
  const answer = await response.json<{ code?: string }>().catch(() => null);
  if (response.status === 429) {
    throw new ToolFailure({
      code: answer?.code || 'PROVIDER_RATE_LIMITED',
      retryAfterSeconds: Number(response.headers.get('retry-after')) || 60,
    });
  }
  throw new ToolFailure({ code: answer?.code || 'UPSTREAM_UNAVAILABLE', upstreamStatus: response.status });
}

// For the abstract, `omitted` counts characters.
type CutList = 'abstract' | 'authors' | 'institutions' | 'concepts' | 'topics' | 'categories' | 'keywords' | 'allCategories';

// Every paper reaches `publicPaper` through `PaperBuilder.create`, which fills
// what a record lacks with these texts. They say "not given".
const PLACEHOLDER_TEXTS = new Set(['No abstract available.', 'Untitled', 'No Title']);
// No record a tool reads (`formatOpenAlexWorkAsPaper`, `mapOpenAlexWork`,
// `arxivRecordPaper`) carries these, so a 0 or `false` here is the builder's.
const UNSUPPLIED_COUNTS = ['referenceCount', 'hasReferences', 'hasData', 'hasSupplement'] as const;
// The OpenAlex mappers name an authorship OpenAlex gave no name with these
// (`mapOpenAlexWork`, `formatOpenAlexWorkAsPaper`), and the second lists one
// such author for a work without authorships.
const PLACEHOLDER_AUTHOR_NAMES = new Set(['Unknown', 'Unknown Author']);

type RelayedAuthor = Partial<PaperAuthor> | string;

// An author keeps what the source gave of it, and no field it did not give
// (an affiliation OpenAlex left out is `null`): one known by its id alone
// stays without a name, and one the source gave nothing of goes.
function knownAuthor(author: Paper['authors'][number]): RelayedAuthor[] {
  if (typeof author === 'string') return [author];
  const known = Object.entries(author).filter(([key, value]) => value !== null && value !== undefined && value !== ''
    && !(key === 'name' && PLACEHOLDER_AUTHOR_NAMES.has(value)));
  return known.length > 0 ? [Object.fromEntries(known)] : [];
}

// What the builder wrote for a field its record did not give goes, so the
// client reads an absent field as unknown, as INSTRUCTIONS tell it to.
function withoutDefaults(paper: Partial<Paper>) {
  const known: Record<string, unknown> = { ...paper };
  if (paper.authors) known.authors = paper.authors.flatMap(knownAuthor);
  for (const [key, value] of Object.entries(known)) {
    const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty || (typeof value === 'string' && PLACEHOLDER_TEXTS.has(value))) delete known[key];
  }
  for (const key of UNSUPPLIED_COUNTS) {
    if (!known[key]) delete known[key];
  }
  // `citationCountKnown: false` stays: it says the count is unknown.
  if (known.citationCountKnown !== true) delete known.citationCount;
  // A preprint record's `false` is about that version; the paper may have been
  // reviewed since (`ownAnswer` in paper-builder.ts). Its status says preprint.
  if (known.peerReviewed === false && known.publicationStatus === 'preprint') delete known.peerReviewed;
  // arXiv reads any DOI on its record as publication, a repository's included,
  // so a `true` with nothing else behind it does not show review.
  if (known.peerReviewed === true && restsOnArxivDoi(paper)) delete known.peerReviewed;
  return known as Omit<Partial<Paper>, 'authors'> & { authors?: RelayedAuthor[] };
}

// The provider's record is left behind, with what only repeats other fields
// (`summary` is the abstract, `allCategories` and `keywords` often the
// categories) or is internal to the feed: the adapter's `provider` label, and
// the `sourceType` that `mapOpenAlexWork` writes as `journal` for every work
// that is not a conference paper, a repository preprint included. Every list
// is bounded, and a list the source never gave stays absent: unknown, not empty.
function publicPaper(paper: Partial<Paper>, { maxAuthors = MAX_AUTHORS, maxAbstract = MAX_SEARCH_ABSTRACT } = {}) {
  const relayed: ReturnType<typeof withoutDefaults> & { omitted?: Partial<Record<CutList, number>> } = withoutDefaults(paper);
  // Compared whole, before the cuts below.
  const categories = JSON.stringify(relayed.categories || []);
  if (JSON.stringify(relayed.allCategories || []) === categories) delete relayed.allCategories;
  if (JSON.stringify(relayed.keywords || []) === categories) delete relayed.keywords;
  const omitted: Partial<Record<CutList, number>> = {};
  const cut = <T>(list: T[], name: CutList, max: number) => {
    if (list.length > max) omitted[name] = list.length - max;
    return list.slice(0, max);
  };
  if (relayed.abstract && relayed.abstract.length > maxAbstract) {
    // At the last space inside the bound, marked, so it is not quoted as whole.
    const kept = relayed.abstract.slice(0, maxAbstract).replace(/\s+\S*$/, '');
    omitted.abstract = relayed.abstract.length - kept.length;
    relayed.abstract = `${kept}…`;
  }
  if (relayed.authors) relayed.authors = cut(relayed.authors, 'authors', maxAuthors);
  if (relayed.institutions) relayed.institutions = cut(relayed.institutions, 'institutions', MAX_INSTITUTIONS);
  if (relayed.concepts) relayed.concepts = cut(relayed.concepts, 'concepts', MAX_SUBJECTS);
  if (relayed.topics) relayed.topics = cut(relayed.topics, 'topics', MAX_TOPICS);
  // An OpenAlex record's categories and keywords are its concepts' names.
  if (relayed.categories) relayed.categories = cut(relayed.categories, 'categories', MAX_SUBJECTS);
  if (relayed.keywords) relayed.keywords = cut(relayed.keywords, 'keywords', MAX_SUBJECTS);
  if (relayed.allCategories) relayed.allCategories = cut(relayed.allCategories, 'allCategories', MAX_SUBJECTS);
  if (Object.keys(omitted).length > 0) relayed.omitted = omitted;
  delete relayed.raw;
  delete relayed.summary;
  delete relayed._followedEntityMatches;
  delete relayed._fetchedFor;
  delete relayed.provider;
  delete relayed.sourceType;
  return relayed;
}

// Both sources are asked for a full page whatever `limit` says, and the merged
// list is cut afterwards: a billed OpenAlex search costs the same for one
// result as for ten, and one question has one cache entry.
async function searchOpenAlex(query: string, since: string, caller: Request, env: WorkerEnv) {
  // The work types the app's search asks for, so errata, paratext, datasets
  // and peer-review records do not fill the page.
  const filters = [`type:${OPENALEX_SEARCH_TYPES.join('|')}`, ...(since ? [`from_publication_date:${since}`] : [])];
  const response = await ask(handleAgentOpenAlex, '/openalex/works', {
    search: query,
    filter: filters.join(','),
    'per-page': MAX_RESULTS,
    select: OPENALEX_WORK_SEARCH_FIELDS.join(','),
  }, caller, env);
  const { results = [] } = await response.json<{ results?: OpenAlexWork[] }>();
  return results.map(work => mapOpenAlexWork(work));
}

// The phrase query the app's search sends (`buildSearchQuery` in
// src/services/arxiv-service.ts), so the same words share its cache entry.
function arxivQuery(query: string, since: string) {
  const phrase = `all:"${query.replace(/"/g, '').trim()}"`;
  if (!since) return phrase;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${phrase} AND submittedDate:[${since.replace(/-/g, '')}0000 TO ${today}2359]`;
}

// What a source that failed is listed as. An answer the tool could not read is
// reported as any exception is.
function sourceFailure(source: string, error: unknown): Record<string, unknown> {
  if (error instanceof ToolFailure) return { source, ...error.details };
  captureWorkerException(error);
  return { source, code: 'UPSTREAM_UNAVAILABLE' };
}

async function arxivPapers(params: Record<string, string | number>, caller: Request, env: WorkerEnv) {
  const response = await ask(handleAgentArxiv, '/arxiv', params, caller, env);
  return parseArxivAtom(await response.text()).map(arxivRecordPaper);
}

async function searchPapers({ query, sources, since, limit }: ReturnType<typeof searchArguments>, caller: Request, env: WorkerEnv) {
  const searches: Record<string, () => Promise<Array<Partial<Paper> | null>>> = {
    openalex: () => searchOpenAlex(query, since, caller, env),
    arxiv: () => arxivPapers({ search_query: arxivQuery(query, since), start: 0, max_results: MAX_RESULTS, sortBy: 'relevance' }, caller, env),
  };
  const settled = await Promise.allSettled(sources.map(source => searches[source]()));
  const unavailable = settled.flatMap(
    (outcome, index) => (outcome.status === 'fulfilled' ? [] : [sourceFailure(sources[index], outcome.reason)]),
  );
  // Each failed source leaves the line and report that the browser's own
  // request to its route would, whether or not the other source answered.
  for (const entry of unavailable) recordFailure('search_papers', entry);
  if (unavailable.length === sources.length) {
    // When every source only refused for a while, the client can retry once
    // the first of them reopens.
    const waits = unavailable.map(entry => Number(entry.retryAfterSeconds));
    throw new ToolFailure({
      code: 'SOURCES_UNAVAILABLE',
      unavailable,
      ...(waits.every(wait => wait > 0) ? { retryAfterSeconds: Math.min(...waits) } : {}),
    });
  }
  const foundBy = (source: string) => settled.flatMap((outcome, index) => (sources[index] === source && outcome.status === 'fulfilled' ? outcome.value : []));
  const ranked = mergeRankedPapers(query, foundBy('openalex'), foundBy('arxiv'), { limit }).map(paper => publicPaper(paper));
  const papers: typeof ranked = [];
  let bytes = 0;
  for (const paper of ranked) {
    const size = new TextEncoder().encode(JSON.stringify(paper)).length + 1;
    if (papers.length > 0 && bytes + size > SEARCH_BUDGET_BYTES) break;
    papers.push(paper);
    bytes += size;
  }
  const left = ranked.length - papers.length;
  return { query, papers, unavailable, ...(left > 0 ? { omitted: { papers: left } } : {}) };
}

function getPaperArguments(args: Arguments) {
  onlyKeys(args, ['id']);
  const identity = paperIdentity(args.id);
  if (!identity) throw new InvalidArguments('id must be a DOI, arXiv id, OpenAlex work id or PubMed id (pmid:123)');
  return identity;
}

// `formatOpenAlexWorkAsPaper` ids a work as `W…`, `mapOpenAlexWork` as
// `openalex:W…`; a search returns the second, so an OpenAlex work keeps one id
// whichever tool returned it and whichever OpenAlex, DOI or PubMed identifier
// found it. An arXiv id that arXiv answers keeps the arXiv id.
function openAlexPaper(work: OpenAlexWork) {
  const paper = formatOpenAlexWorkAsPaper(work);
  return { paper: publicPaper({ ...paper, id: `openalex:${paper.id}` }, PAPER_BOUNDS) };
}

// arXiv refuses an agent whenever the beat's current seat is taken, by a
// search's own arXiv miss too, or is one a reader may still need
// (`handleAgentArxiv`). OpenAlex indexes the
// same preprints, so a refusal or failure asks it for the work at the arXiv
// landing page, as the app's paper page does (`fetchPaperByArxivIdViaOpenAlex`):
// one billed unit, in the agent tier. arXiv's answer that it has no such
// paper stands.
async function getArxivPaper(arxivId: string, caller: Request, env: WorkerEnv) {
  let papers: Paper[];
  try {
    papers = await arxivPapers({ id_list: arxivId, max_results: 1 }, caller, env);
  } catch (error) {
    if (!(error instanceof ToolFailure) || error.details.code === 'INVALID_ARGUMENTS') throw error;
    const work = await ask(handleAgentOpenAlex, '/openalex/works', {
      filter: `locations.landing_page_url:http://arxiv.org/abs/${arxivId}|https://arxiv.org/abs/${arxivId}`,
      per_page: 1,
    }, caller, env)
      .then(response => response.json<{ results?: OpenAlexWork[] }>())
      // The paper's `arxivId` is read off the work, so it has to be this one.
      .then(({ results = [] }) => results.find(found => getArxivIdFromWork(found).toLowerCase() === arxivId))
      .catch((failure: unknown) => {
        recordFailure('get_paper', sourceFailure('openalex', failure));
        return undefined;
      });
    if (!work?.id) throw error;
    // The tool answers, so its failure would leave no line of its own.
    recordFailure('get_paper', { source: 'arxiv', ...error.details });
    return openAlexPaper(work);
  }
  if (!papers[0]) throw new ToolFailure({ code: 'NOT_FOUND' });
  return { paper: publicPaper(papers[0], PAPER_BOUNDS) };
}

async function getPaper(identity: ReturnType<typeof getPaperArguments>, caller: Request, env: WorkerEnv) {
  if (identity.type === 'arxiv') return getArxivPaper(identity.value.replace(/v\d+$/, ''), caller, env);
  // One work by id, as the app's paper page asks for it (`fetchPaperByWorkId`
  // in src/services/open-alex-service.ts): OpenAlex does not bill it, so it
  // spends no budget. A DOI the relay cannot carry in its path is a one-work
  // list instead, billed one unit in the exploration tier.
  const doiPath = identity.type === 'doi' ? doiPathId(identity.value) : '';
  const response = identity.type === 'doi' && !doiPath
    ? await ask(handleAgentOpenAlex, '/openalex/works', { filter: `doi:${identity.value}`, 'per-page': 1 }, caller, env)
    : await ask(handleAgentOpenAlex, `/openalex/works/${doiPath || encodeURIComponent(identity.type === 'pmid' ? `pmid:${identity.value}` : identity.value)}`, {}, caller, env);
  const answer = await response.json<OpenAlexWork & { results?: OpenAlexWork[] }>();
  const work = answer.results ? answer.results[0] : answer;
  if (!work?.id) throw new ToolFailure({ code: 'NOT_FOUND' });
  // `,` and `|` in the DOI are filter syntax, so a list can answer with a work
  // of another DOI: the work has to be the one asked for.
  if (answer.results && String(work.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() !== identity.value.toLowerCase()) {
    throw new ToolFailure({ code: 'NOT_FOUND' });
  }
  return openAlexPaper(work);
}

function openAccessArguments(args: Arguments) {
  onlyKeys(args, ['doi']);
  return { doi: doiArgument(args.doi) };
}

async function findOpenAccess({ doi }: ReturnType<typeof openAccessArguments>, caller: Request, env: WorkerEnv) {
  const response = await ask(handleOpenAccess, '/oa', { doi }, caller, env);
  const record = await response.json<Record<string, unknown> & { oa_locations?: unknown[] }>();
  const locations = record.oa_locations || [];
  return {
    doi,
    is_oa: record.is_oa ?? null,
    oa_status: record.oa_status ?? null,
    best_oa_location: record.best_oa_location ?? null,
    oa_locations: locations.slice(0, MAX_OA_LOCATIONS),
    ...(locations.length > MAX_OA_LOCATIONS ? { omitted: { oa_locations: locations.length - MAX_OA_LOCATIONS } } : {}),
    source: record.source || 'unpaywall',
  };
}

// Each tool's arguments are read once, then the call runs on what was read.
function tool<T>(parse: (args: Arguments) => T, run: (parsed: T, caller: Request, env: WorkerEnv) => Promise<Record<string, unknown>>) {
  return (args: Arguments) => {
    const parsed = parse(args);
    return (caller: Request, env: WorkerEnv) => run(parsed, caller, env);
  };
}

const RUN: Record<ToolName, ReturnType<typeof tool>> = {
  search_papers: tool(searchArguments, searchPapers),
  get_paper: tool(getPaperArguments, getPaper),
  find_open_access: tool(openAccessArguments, findOpenAccess),
};

// A tool failure is an HTTP 200 answer, so `index.ts` never sees it. This writes
// the line it writes for a 429 or 5xx (route and status, here with the tool,
// the searched source and the code) and reports a 5xx the way it reports one.
// The arguments stay out of it.
function recordFailure(tool: string, details: Record<string, unknown>) {
  // `searchPapers` recorded each of its sources.
  if (details.code === 'SOURCES_UNAVAILABLE') return;
  const code = String(details.code);
  const upstreamStatus = Number(details.upstreamStatus) || 0;
  const status = code === 'QUOTA_LEDGER_UNAVAILABLE' ? 503
    : details.retryAfterSeconds !== undefined ? 429
    : upstreamStatus >= 500 ? upstreamStatus
      : /^(?:UPSTREAM_|PROVIDER_QUOTA_NOT_CONFIGURED$)/.test(code) ? 503 : 0;
  if (!status) return;
  console.warn(JSON.stringify({ route: MCP_PATH, tool, ...(details.source ? { source: details.source } : {}), code, status }));
  captureWorkerResponseFailure(status);
}

// The arguments are checked before the reservation, so a malformed call costs
// nothing; the reservation comes before any route, so a refused call asks nothing.
async function callTool(params: Record<string, unknown>, request: Request, env: WorkerEnv) {
  const name = String(params.name);
  const failed = (details: Record<string, unknown>) => {
    recordFailure(name, details);
    return toolResult(details, true);
  };
  const args = params.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return failed({ code: 'INVALID_ARGUMENTS', message: 'arguments must be an object' });
  }
  try {
    const run = RUN[name as ToolName](args as Arguments);
    const caller = await reserveCallerMinute(request, env, MCP_CALLER_MINUTE.namespace, MCP_CALLER_MINUTE.limit);
    // A missing secret or ledger binding is configuration; a ledger that did
    // not answer is an outage the client can retry after.
    if (caller.reading.code === 'CALLER_IDENTITY_NOT_CONFIGURED' || caller.reading.code === 'QUOTA_LEDGER_NOT_CONFIGURED') {
      return failed({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' });
    }
    if (caller.reading.code) return failed({ code: 'QUOTA_LEDGER_UNAVAILABLE', retryAfterSeconds: Number(caller.retryAfter) });
    if (!caller.reading.accepted) {
      return failed({ code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: Number(caller.retryAfter) });
    }
    return toolResult(await run(request, env));
  } catch (error) {
    if (error instanceof InvalidArguments) return failed({ code: 'INVALID_ARGUMENTS', message: error.message });
    if (error instanceof ToolFailure) return failed(error.details);
    throw error;
  }
}

/** POST `/mcp`: one JSON-RPC message per request, answered as JSON. */
export async function handleMcpRequest(request: Request, env: WorkerEnv) {
  // The transport requires the Origin check against DNS rebinding. Remote
  // clients such as claude.ai send none; a browser page must be ours.
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins(env).has(origin)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  }
  const version = request.headers.get('mcp-protocol-version') || DEFAULT_PROTOCOL_VERSION;
  if (!PROTOCOL_VERSIONS.includes(version)) return rpcError(null, -32600, 'Unsupported MCP-Protocol-Version', 400);

  let message: unknown;
  try {
    message = await readBoundedJson(request, MAX_BODY_BYTES, {
      tooLarge: () => new RangeError('too large'),
      invalid: () => new SyntaxError('invalid'),
    });
  } catch (error) {
    if (error instanceof RangeError) return rpcError(null, -32600, 'Request body too large', 413);
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(message)) return rpcError(null, -32600, 'Batches are not supported', 400);
  const { jsonrpc, id, method, params = {} } = (message || {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  if (jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid Request', 400);
  if (typeof method !== 'string') return rpcError(null, -32600, 'Invalid Request', 400);
  // A notification. This server sends no requests, so it expects no responses.
  if (id === undefined) return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
  if (typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }

  if (method === 'initialize') {
    const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    if (!params || typeof params !== 'object' || !Object.hasOwn(RUN, String(params.name))) {
      return rpcError(id, -32602, 'Unknown tool');
    }
    try {
      return rpcResult(id, await callTool(params, request, env));
    } catch (error) {
      // The ledger or a provider answered with something the tool cannot read.
      // The client matches this reply to its request by `id`.
      captureWorkerException(error);
      console.error('MCP tool call failed', error);
      return rpcError(id, -32603, 'Internal error', 500);
    }
  }
  return rpcError(id, -32601, 'Method not found');
}
