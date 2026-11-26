import type { Paper, PaperAuthor } from '../src/models/paper.ts';
import type { CustomFeed, CustomFeedOrder, FeedIngredient } from '../src/utils/custom-feeds.ts';
import type { AgentIdentity, AgentScope } from './agent-token.ts';
import type { FirestoreAdmin, FirestoreWrite } from './firestore-admin.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { isPlaceholderAuthorName, restsOnArxivDoi } from '../src/services/paper-builder.ts';
import { mergeRankedPapers } from '../src/services/paper-search-merge.ts';
import { CREATE_LIST_FORM_INITIAL, MAX_LIST_NAME_LENGTH } from '../src/utils/create-list-form-model.ts';
import {
  CustomFeedError, MAX_CUSTOM_FEEDS, MAX_FEED_INGREDIENTS, MAX_FEED_NAME_LENGTH,
  feedNameProblem, ingredientProblem, parseCustomFeeds, parseFeedIngredient, withFeedAdded,
} from '../src/utils/custom-feeds.ts';
import { encodeFirestoreDocId } from '../src/utils/firestore-doc-id.ts';
import { buildSavedPaperPayload } from '../src/utils/saved-paper-payload.ts';
import { usableOpenAlexConcepts } from '../src/utils/open-alex-concepts.ts';
import { OPENALEX_SEARCH_TYPES, OPENALEX_WORK_SEARCH_FIELDS, doiPathId, formatOpenAlexWorkAsPaper, mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { DEFAULT_PUBLIC_ORIGIN, getPaperIdentity, normalizeArxivId, normalizeDoi } from '../src/utils/public-navigation.ts';
import { OPENALEX_VENUE_SOURCE_TYPES } from '../src/utils/publication-status.ts';
import { verifyAgentToken } from './agent-token.ts';
import { handleAgentArxiv } from './arxiv-api.ts';
import { readBoundedJson } from './bounded-body.ts';
import { reserveAccountDay, reserveAccountMinute, reserveCallerMinute } from './caller-quota.ts';
import { handleCitationGraph } from './citation-graph.ts';
import { captureWorkerException, captureWorkerResponseFailure } from './error-tracking.ts';
import { WorkerAuthError } from './firebase-auth.ts';
import { isServiceAccountConfigured } from './firebase-service-account.ts';
import { FirestoreAdminError, createFirestoreAdmin, createWrite, mergeWrite } from './firestore-admin.ts';
import { allowedOrigins, json } from './http.ts';
import { handleOpenAccess } from './open-access.ts';
import { handleAgentOpenAlex } from './openalex-api.ts';
import { arxivRecordPaper, parseArxivAtom } from './paper-sources.ts';
import { MAX_LIST_PAPER_IDS } from './public-list-api.ts';
import { releaseRequestQuota } from './request-quota-ledger.ts';
import { handleRelated } from './semantic-scholar.ts';

/**
 * PaperTok as a remote MCP server (ENG-91). Streamable HTTP without sessions
 * or server-sent events: every POST carries one JSON-RPC message and gets one
 * JSON answer. The official SDK is not used; this handler covers the four
 * methods the server needs.
 *
 * A request without an `Authorization` header is phase 1's: public,
 * read-only, no account. One that carries an agent token (`agent-token.ts`)
 * also gets the account tools its scopes allow, and its calls count against
 * the account. A header that is not a valid token is refused: a caller that
 * presents a credential is never served as an anonymous one.
 *
 * Every public tool asks an existing route in-process, as `paper-sources.ts`
 * does for the harvest, but much as a reader: the route's validation, cache
 * keys, provider budgets and per-address allowances apply as they do to the
 * browser. The caller's `CF-Connecting-IP` travels with each ask, so those
 * allowances count this caller. ENG-91 puts agents in the lowest budget tier:
 * a billed OpenAlex miss spends `exploration` (`handleAgentOpenAlex`), and an
 * arXiv miss takes only the current period's public seat, and none a reader
 * booked (`handleAgentArxiv`). The citation graph and the recommendations
 * are account tools because their routes charge each reader's share of the
 * credential-backed providers' minute allowance.
 */
export const MCP_PATH = '/mcp';

// Newest first: a version not listed asked for in `initialize` gets the first.
// 2025-03-26 is not listed: its transport requires JSON-RPC batches, which
// this server refuses, and the two later versions dropped them.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18'];
const MAX_BODY_BYTES = 16 * 1024;
// Tool calls one address may make in a UTC minute, cache hits included, or
// one account when the request carries an agent token. The routes behind them
// keep their own per-address limits on misses.
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
const PAPER_BOUNDS = Object.freeze({ maxAuthors: MAX_PAPER_AUTHORS, maxAbstract: Infinity, maxCategories: MAX_SUBJECTS });
// The paper a write tool saves a copy of: get_paper's, with every category its
// record has. A result's five are a cut for the client's reading, and the copy
// keeps as many as the app's own save does (`storedClassification`); a copy
// stored short would stay short, since the app does not ask again for one.
const COPY_BOUNDS = Object.freeze({ ...PAPER_BOUNDS, maxCategories: Infinity });
interface PaperBounds { maxAuthors: number; maxAbstract: number; maxCategories: number }
// What the account tools return of a paper is its identifiers, title and
// first authors, so a hundred papers of a list fit in one result.
const MAX_LISTED_AUTHORS = 5;
// How many papers of each relation the app asks `/citation-graph` for. The
// limit is part of the route's cache key, so a tool asks for as many: when it
// also asks with the DOI as the app sent it, the two share one entry and
// OpenAlex is billed once for that graph. The key keeps the DOI's case, and a
// tool sends it lowercased.
const MAX_NEIGHBOURS = 8;
const MAX_LISTS = 50;
const MAX_LIST_PAPERS = 100;
// A list id and a paper id are Firestore document names.
const MAX_LIST_ID_LENGTH = 160;
const MAX_PAPER_ID_LENGTH = 500;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';
// What one call of a write tool may ask the providers for: each paper or
// OpenAlex entity is one lookup, and each lookup counts as one more call
// against the account's minute (MCP_CALLER_MINUTE), as a get_paper would.
const MAX_WRITE_PAPERS = 25;
const MAX_ENTITY_LOOKUPS = 10;
const LOOKUP_CONCURRENCY = 4;
// Every lookup of one call answers within this, or its paper or entity is not added.
const LOOKUP_DEADLINE_MS = 20_000;
// What one account's agents may write in a UTC day, each counted in the quota ledger.
const DAILY_WRITES = Object.freeze({
  lists: { namespace: 'mcp-lists-created', limit: 20, code: 'LISTS_DAILY_LIMIT' },
  feeds: { namespace: 'mcp-feeds-created', limit: 20, code: 'FEEDS_DAILY_LIMIT' },
  papers: { namespace: 'mcp-papers-added', limit: 200, code: 'PAPERS_DAILY_LIMIT' },
});
// The topics and authors of a paper that create_feed turns into ingredients.
const MAX_PAPER_FEED_TOPICS = 3;
const MAX_PAPER_FEED_AUTHORS = 3;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const SERVER_INFO = Object.freeze({ name: 'papertok', title: 'PaperTok', version: '1.2.0' });
// What `initialize` tells the client, by what the connection can do. A request
// without a token and a token that only reads get the read-only opening; a
// token with a write scope gets one that says it writes. Each sentence about
// account tools is sent only with the scope that lists those tools.
const READ_ONLY_OPENING = 'Read-only access to scholarly papers as PaperTok normalizes them.';
const WRITING_OPENING = 'Access to scholarly papers as PaperTok normalizes them, and to one PaperTok account, which the write tools this connection lists change.';
const PAPER_INSTRUCTIONS = 'Results carry abstracts and metadata, never full text. citationCount is given only where citationCountKnown is true. A field a paper lacks, such as its abstract, review status or open-access status, is unknown, not empty, zero or false.';
const INSTRUCTIONS = `${READ_ONLY_OPENING} ${PAPER_INSTRUCTIONS}`;
const ACCOUNT_INSTRUCTIONS = 'This connection is signed in to one PaperTok account: list_my_lists, get_list and list_my_feeds read that account\'s own lists and custom feeds, and every call counts against the account. find_similar_papers, get_citation_graph and get_list name each paper by its identifiers, title and first authors only; get_paper returns the rest.';
const SIGNED_IN_INSTRUCTIONS = 'This connection is signed in to one PaperTok account, and every call counts against the account.';
const WRITE_INSTRUCTIONS = 'The write tools this connection lists make private lists and custom feeds in that account and add papers to its private lists; they publish and delete nothing, and list in notAdded what they left out.';

function instructionsFor(agent: AgentIdentity | null) {
  if (!agent) return INSTRUCTIONS;
  const writes = agent.scopes.some(scope => scope.endsWith(':write'));
  return [
    writes ? WRITING_OPENING : READ_ONLY_OPENING,
    PAPER_INSTRUCTIONS,
    agent.scopes.includes('account:read') ? ACCOUNT_INSTRUCTIONS : SIGNED_IN_INSTRUCTIONS,
    ...(writes ? [WRITE_INSTRUCTIONS] : []),
  ].join(' ');
}

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
// A tool that reads only the account's own documents.
const READ_OWN = Object.freeze({ ...READ_ONLY, openWorldHint: false });
// A tool that adds to the account's own documents and removes nothing. Its
// lookups ask providers for papers and names; what it writes stays in PaperTok.
const WRITE_OWN = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const REQUEST_ID_SCHEMA = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$', description: 'Any value of 8 to 64 letters, digits, "_" or "-". Pass the same value when retrying the same call, so a retry does not create a second one. Use a new value for a different call: a value already used returns what its first call made and ignores the other arguments.' };
const PAPER_ID_SCHEMA = { type: 'string', description: 'A DOI (10.xxxx/...), arXiv id (2401.01234), OpenAlex work id (W123...) or PubMed id (pmid:123). URLs and doi:/arxiv: prefixes are accepted.' };
const DOI_SCHEMA = { type: 'string', description: 'The DOI, with or without https://doi.org/.' };

const TOOLS = [
  {
    name: 'search_papers',
    title: 'Search papers',
    description: `Searches OpenAlex and arXiv and merges records of the same paper by DOI, arXiv id, or an identical title with a shared first-author name. A paper has its openalex:W… id when OpenAlex found it, else its arXiv id, and arXiv categories when arXiv found it, else OpenAlex concept names, or topic names for a work without concepts. taxonomySources identifies the provider of categories, concepts and topics when present. Returns at most ${MAX_RESULTS} papers in PaperTok's paper format, with abstracts cut at ${MAX_SEARCH_ABSTRACT} characters (get_paper returns the whole abstract), author lists at ${MAX_AUTHORS} names, institutions at ${MAX_INSTITUTIONS}, concepts and category names at ${MAX_SUBJECTS}, and topics at ${MAX_TOPICS}; a paper's "omitted" counts the entries each cut list left out, and the characters for the abstract. Papers of very large collaborations can return fewer papers than the limit; the result's "omitted.papers" counts those left out. A source that is unavailable or over its budget is listed in "unavailable". arXiv is asked only when PaperTok's arXiv pacing has a free slot for AI clients (about one try in two); otherwise it is listed there as PROVIDER_RATE_LIMITED with retryAfterSeconds, while arXiv itself may be idle.`,
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
    description: `Looks one paper up by DOI, arXiv id, OpenAlex work id or PubMed id (pmid:123) and returns it in PaperTok's paper format (abstract and metadata, not full text). An arXiv id is looked up on arXiv when PaperTok's arXiv pacing has a free slot for AI clients (about one try in two). If pacing refuses the lookup or the arXiv relay fails, the tool asks OpenAlex. If the relay returns an unreadable feed or an Atom error entry, the tool returns UPSTREAM_UNAVAILABLE without a fallback. Other identifiers are looked up on OpenAlex. When OpenAlex does not return the paper either, the error is arXiv's, and a refusal by the pacing is PROVIDER_RATE_LIMITED with retryAfterSeconds. An OpenAlex answer has an openalex:W… id. Categories are arXiv categories when available, otherwise OpenAlex concept names or topic names. Cached OpenAlex subjects require an OpenAlex work id in the detail response. Cached arXiv categories require its arXiv id. A DOI alone cannot recover either taxonomy. taxonomySources identifies the provider of categories, concepts and topics when present. A successful OpenAlex fallback includes a top-level fallback with from, to and the arXiv error code. Authors are cut at ${MAX_PAPER_AUTHORS} names, institutions at ${MAX_INSTITUTIONS}, concepts and category names at ${MAX_SUBJECTS}, and topics at ${MAX_TOPICS}; "omitted" counts the entries each cut list left out.`,
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

const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false };

// Listed only for a request whose agent token carries the tool's scope
// (`ACCOUNT_RUN`).
const ACCOUNT_TOOLS = [
  {
    name: 'find_similar_papers',
    title: 'Find similar papers',
    description: `Papers Semantic Scholar recommends for one paper. Semantic Scholar knows a paper by its DOI or arXiv id, so an OpenAlex work id or PubMed id is first looked up on OpenAlex for one of them. Returns up to "limit" recommendations in Semantic Scholar's order. Each has the title, up to ${MAX_AUTHORS} author names, the year, the DOI and the arXiv id its record carries, and an "id" for get_paper when it has a DOI or arXiv id. A recommendation carries no venue, review status, citation count or categories: get_paper returns those. "omitted.papers" counts the recommendations past the limit, and a paper's "omitted.authors" the names cut. A paper Semantic Scholar has not indexed is PAPER_NOT_INDEXED.`,
    inputSchema: {
      type: 'object',
      properties: { id: PAPER_ID_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, default: MAX_RESULTS } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_citation_graph',
    title: 'Get a citation graph',
    description: `The papers one paper cites ("references") and the papers that cite it ("citations"), from OpenCitations and OpenAlex. The graph is asked by DOI: an arXiv id is asked as arXiv's own DOI (10.48550/arXiv.<id>), and an OpenAlex work id or PubMed id is first looked up on OpenAlex for the paper's DOI. Returns up to ${MAX_NEIGHBOURS} papers of each relation. Each has an "id" for get_paper, the title, up to ${MAX_LISTED_AUTHORS} author names, the year and the DOI its record carries, and citationCount where the count is known; "omitted.authors" counts the names cut, of at most 20 the graph keeps. "counts" is how many papers of each relation the sources list, and "omitted" how many of those are not returned. "degraded": true means a source failed, so the lists and counts can be short. "partial": true means OpenAlex supplied what OpenCitations did not.`,
    inputSchema: { type: 'object', properties: { id: PAPER_ID_SCHEMA }, required: ['id'], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'list_my_lists',
    title: 'List my lists',
    description: `The paper lists of the signed-in PaperTok account: each list's id, name, paperCount, whether it is public (published as a share page), updatedAt when the list records it, and the url of its page in PaperTok, which opens for that account only. Returns up to ${MAX_LISTS} lists; "omitted.lists" counts the rest. get_list returns a list's papers.`,
    inputSchema: NO_ARGUMENTS,
    annotations: READ_OWN,
  },
  {
    name: 'get_list',
    title: 'Get a list',
    description: `One list of the signed-in PaperTok account, by the id list_my_lists gives, with the url of its page in PaperTok and its papers in the list's order: up to ${MAX_LIST_PAPERS}, with "omitted.papers" counting the rest. Each paper has its PaperTok id and, from the copy saved with the account, the title, up to ${MAX_LISTED_AUTHORS} author names, the publication date, the DOI and the arXiv id the copy carries; "omitted.authors" counts the names cut, of at most 20 a copy keeps. A paper whose copy is missing has "metadata": "unavailable" and its id alone. get_paper takes a paper's DOI or arXiv id.`,
    inputSchema: {
      type: 'object',
      properties: { listId: { type: 'string', minLength: 1, maxLength: MAX_LIST_ID_LENGTH, description: 'A list id from list_my_lists.' } },
      required: ['listId'],
      additionalProperties: false,
    },
    annotations: READ_OWN,
  },
  {
    name: 'list_my_feeds',
    title: 'List my feeds',
    description: 'The custom feeds of the signed-in PaperTok account, at most 8: each feed\'s id, name, order ("newest" or "best"), its ingredients (at most 20) and the url of its page in PaperTok, which opens for that account only. An ingredient is an area or category of PaperTok\'s taxonomy by id, an OpenAlex topic, author or journal by id with its label, or a keyword with its query.',
    inputSchema: NO_ARGUMENTS,
    annotations: READ_OWN,
  },
  {
    name: 'create_list',
    title: 'Create a private list',
    description: `Creates a private paper list in the signed-in PaperTok account, optionally with up to ${MAX_WRITE_PAPERS} papers. The list is private: this tool cannot publish it, and no tool here deletes or renames a list. Each paper id is looked up as get_paper looks it up, and each lookup counts as one more call against the account's minute. A paper is filed under the id of the record found (an arXiv id, or openalex:W…), and a copy of its title, authors and identifiers is saved with the account. "added" lists the papers in the list. "notAdded" lists each id left out with a code: INVALID_ID, DUPLICATE, LOOKUP_TIMEOUT, or the code get_paper would give (NOT_FOUND, PROVIDER_RATE_LIMITED, UPSTREAM_UNAVAILABLE). When ids were given and none could be added, nothing is created and the error is NO_PAPERS_ADDED. The first call with a requestId wins: a later call with that requestId returns the list the first one made, with "existing": true and without "added" or "notAdded", and changes nothing, whatever name or papers it asks for. Compare the returned name and paperCount with what you asked for. An account's agents create at most ${DAILY_WRITES.lists.limit} lists and add at most ${DAILY_WRITES.papers.limit} papers a UTC day (LISTS_DAILY_LIMIT, PAPERS_DAILY_LIMIT, with retryAfterSeconds). Returns the list's id, name, paperCount and the url of its page in PaperTok, which opens for that account only.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: MAX_LIST_NAME_LENGTH, description: 'The name the reader will see.' },
        paperIds: { type: 'array', items: PAPER_ID_SCHEMA, maxItems: MAX_WRITE_PAPERS, description: 'Papers to put in the list, in order.' },
        requestId: REQUEST_ID_SCHEMA,
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: WRITE_OWN,
  },
  {
    name: 'add_papers_to_list',
    title: 'Add papers to a private list',
    description: `Adds up to ${MAX_WRITE_PAPERS} papers to the end of one private list of the signed-in PaperTok account, by the list id list_my_lists gives. A list that is public (published as a share page) is refused with LIST_IS_PUBLIC: this tool changes private lists only. Nothing is removed or reordered. Papers are looked up, filed and copied as create_list does. A list holds at most ${MAX_LIST_PAPER_IDS} papers. "added" lists the papers added. "notAdded" lists each id left out with a code: ALREADY_IN_LIST, LIST_FULL, INVALID_ID, DUPLICATE, LOOKUP_TIMEOUT, or the code get_paper would give. When no paper is added and none was already in the list, the error is NO_PAPERS_ADDED. Adding the same papers again changes nothing. An account's agents add at most ${DAILY_WRITES.papers.limit} papers a UTC day (PAPERS_DAILY_LIMIT, with retryAfterSeconds and what is left as "remaining").`,
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', minLength: 1, maxLength: MAX_LIST_ID_LENGTH, description: 'A list id from list_my_lists or create_list.' },
        paperIds: { type: 'array', items: PAPER_ID_SCHEMA, minItems: 1, maxItems: MAX_WRITE_PAPERS },
      },
      required: ['listId', 'paperIds'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_OWN, idempotentHint: true },
  },
  {
    name: 'create_feed',
    title: 'Create a custom feed',
    description: `Creates a custom feed in the signed-in PaperTok account: a named set of ingredients whose recent papers PaperTok shows the reader. A feed is private to the account, and no tool here deletes or edits one. Give either "fromPaperId" or "ingredients". With fromPaperId, PaperTok reads the paper's OpenAlex record and uses its topics (the primary one first, at most ${MAX_PAPER_FEED_TOPICS}), and with "include": ["topics", "authors"] also its first ${MAX_PAPER_FEED_AUTHORS} authors. With ingredients, each is { "kind": "area" | "category", "id" } from PaperTok's taxonomy, { "kind": "topic" | "author" | "journal", "id" } with an OpenAlex id (T…, A…, S…), or { "kind": "keyword", "query" }. PaperTok looks each topic, author and journal up on OpenAlex and stores OpenAlex's name for it, at most ${MAX_ENTITY_LOOKUPS} a call; a "label" sent with one is ignored. Each lookup counts as one more call against the account's minute. "notAdded" lists each ingredient left out with a code: INVALID_INGREDIENT, TOO_MANY_LOOKUPS, LOOKUP_TIMEOUT, ENTITY_NOT_CONFIRMED, the lookup's own code, or the limit it met (DUPLICATE, FEED_FULL, JOURNALS_FULL, ENTITIES_FULL, KEYWORDS_FULL). When no ingredient is left the error is NO_FEED_INGREDIENTS. An account holds at most ${MAX_CUSTOM_FEEDS} feeds (FEED_LIMIT_REACHED) with different names (FEED_NAME_TAKEN). The first call with a requestId wins: a later call with that requestId returns the feed the first one made, with "existing": true and without "notAdded", and changes nothing, whatever name, order or ingredients it asks for. An account's agents create at most ${DAILY_WRITES.feeds.limit} feeds a UTC day (FEEDS_DAILY_LIMIT, with retryAfterSeconds). Returns the feed's id, name, order, ingredients and the url of its page in PaperTok.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: MAX_FEED_NAME_LENGTH, description: 'The name of the feed\'s tab.' },
        order: { type: 'string', enum: ['newest', 'best'], default: 'newest', description: '"newest": the latest papers, day by day. "best": the closest matches first.' },
        fromPaperId: PAPER_ID_SCHEMA,
        include: { type: 'array', items: { type: 'string', enum: ['topics', 'authors'] }, minItems: 1, uniqueItems: true, default: ['topics'], description: 'With fromPaperId only.' },
        ingredients: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_FEED_INGREDIENTS,
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['area', 'category', 'topic', 'author', 'journal', 'keyword'] }, id: { type: 'string' }, query: { type: 'string' } },
            required: ['kind'],
          },
        },
        requestId: REQUEST_ID_SCHEMA,
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: WRITE_OWN,
  },
] as const;

type ToolName = typeof TOOLS[number]['name'];
type AccountToolName = typeof ACCOUNT_TOOLS[number]['name'];
type Account = Pick<AgentIdentity, 'uid'>;
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

function rpcError(id: RpcId | null, code: number, message: string, status = 200, headers: Record<string, string> = {}) {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status, { 'cache-control': 'no-store', ...headers });
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

// A DOI link carries the DOI percent-encoded (`https://doi.org/10.1234/a%3Fb`
// is 10.1234/a?b), so the link is decoded once, and only a link: a DOI given
// as itself is read as written, a literal `%25` in it included.
const DOI_LINK = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i;

function paperIdentity(value: unknown) {
  if (typeof value !== 'string' || value.length > 300) return null;
  let text = value.trim();
  if (DOI_LINK.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      // A `%` that starts no escape is the DOI's own; the DOI grammar decides.
    }
  }
  const identity = getPaperIdentity(text, undefined);
  const separator = identity.indexOf(':');
  // An OpenReview forum id is an address in the app, where the paper page
  // asks OpenReview for it. `get_paper` asks OpenAlex and arXiv, which hold
  // no such id, so here it is not an id at all.
  if (separator <= 0 || identity.startsWith('openreview:')) return null;
  return { type: identity.slice(0, separator), value: identity.slice(separator + 1) };
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

// A provider's `retry-after`, which the routes relay as they received it, is
// whole seconds or an HTTP date (RFC 9110, section 10.2.3) in one of its three
// forms (section 5.6.7): "Sun, 06 Nov 1994 08:49:37 GMT", the obsolete
// "Sunday, 06-Nov-94 08:49:37 GMT" and asctime's "Sun Nov  6 08:49:37 1994",
// which is in GMT too. A date already past is a wait of one second, and a
// header that is neither is the minute the router assumes for a provider that
// gave none: `Date.parse` alone read "1.5" or "-5" as dates in 2001. A day
// bounds a bogus header, as it does in the browser's OpenAlex client.
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const HTTP_DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const HTTP_MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const HTTP_TIME = '\\d{2}:\\d{2}:\\d{2}';
const GMT_DATE = new RegExp(`^(?:${HTTP_DAY}, \\d{2} ${HTTP_MONTH} \\d{4}|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, \\d{2}-${HTTP_MONTH}-\\d{2}) ${HTTP_TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${HTTP_DAY} ${HTTP_MONTH} [ \\d]\\d ${HTTP_TIME} \\d{4}$`);
function retryAfterSeconds(header: string | null | undefined) {
  const value = String(header || '').trim();
  const at = GMT_DATE.test(value) ? Date.parse(value) : ASCTIME_DATE.test(value) ? Date.parse(`${value} GMT`) : NaN;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((at - Date.now()) / 1000);
  if (Number.isNaN(seconds)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_SECONDS);
}

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
    if (status === 429) throw new ToolFailure({ code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: retryAfterSeconds(retryAfter) });
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
      retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
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

type RelayedAuthor = Partial<PaperAuthor> | string;

// An author keeps what the source gave of it, and no field it did not give
// (an affiliation OpenAlex left out is `null`): one known by its id alone
// stays without a name, and one the source gave nothing of goes. The OpenAlex
// mappers name an authorship without a name with a placeholder, and
// `formatOpenAlexWorkAsPaper` lists one such author for a work without any.
function knownAuthor(author: Paper['authors'][number]): RelayedAuthor[] {
  if (typeof author === 'string') return [author];
  const known = Object.entries(author).filter(([key, value]) => value !== null && value !== undefined && value !== ''
    && !(key === 'name' && isPlaceholderAuthorName(value)));
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
  // An arXiv record that lists a publisher's DOI reads as published
  // (`arxivDoiSaysPublished`; arXiv's own DOI or a repository's leaves it a
  // preprint), but a `true` with nothing else behind it does not show review.
  if (known.peerReviewed === true && restsOnArxivDoi(paper)) delete known.peerReviewed;
  return known as Omit<Partial<Paper>, 'authors'> & { authors?: RelayedAuthor[] };
}

// The provider's record is left behind, with what only repeats other fields
// (`summary` is the abstract, `allCategories` and `keywords` often the
// categories) or is internal to the feed: the adapter's `provider` label, and
// the `sourceType` that `mapOpenAlexWork` writes as `journal` for every work
// that is not a conference paper, a repository preprint included. Every list
// is bounded, and a list the source never gave stays absent: unknown, not empty.
function publicPaper(paper: Partial<Paper>, { maxAuthors = MAX_AUTHORS, maxAbstract = MAX_SEARCH_ABSTRACT, maxCategories = MAX_SUBJECTS } = {}) {
  const relayed: ReturnType<typeof withoutDefaults> & { omitted?: Partial<Record<CutList, number>> } = withoutDefaults(paper);
  if (!relayed.concepts && relayed.topics) {
    const subjects = usableOpenAlexConcepts(relayed.topics);
    if (subjects.length) relayed.concepts = subjects;
  }
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
  if (relayed.categories) relayed.categories = cut(relayed.categories, 'categories', maxCategories);
  if (relayed.keywords) relayed.keywords = cut(relayed.keywords, 'keywords', MAX_SUBJECTS);
  if (relayed.allCategories) relayed.allCategories = cut(relayed.allCategories, 'allCategories', MAX_SUBJECTS);
  if (Object.keys(omitted).length > 0) relayed.omitted = omitted;
  delete relayed.raw;
  delete relayed.summary;
  delete relayed._followedEntityMatches;
  delete relayed._fetchedFor;
  delete relayed.provider;
  delete relayed.sourceType;
  const taxonomySources = {
    ...(relayed.categories && { categories: relayed.primaryCategory ? 'arxiv' : 'openalex' }),
    ...(relayed.concepts && { concepts: 'openalex' }),
    ...(relayed.topics && { topics: 'openalex' }),
  };
  return { ...relayed, ...(Object.keys(taxonomySources).length > 0 && { taxonomySources }) };
}

type TaxonomySource = 'openalex' | 'arxiv';
type SearchTaxonomy = Pick<Partial<Paper>, 'categories' | 'primaryCategory' | 'concepts' | 'topics' | 'primaryTopic'>;

function taxonomyKey(source: TaxonomySource, recordId: string | undefined, caller: Request) {
  if (!recordId) return undefined;
  const identity = getPaperIdentity(source, recordId);
  const id = source === 'arxiv' ? identity.replace(/v\d+$/, '') : identity;
  return id ? new URL(`/mcp/taxonomy/v3/${encodeURIComponent(id)}`, caller.url).href : undefined;
}

async function rememberTaxonomy(record: Partial<Paper>, caller: Request) {
  const source = record.sources?.primary;
  if (source !== 'openalex' && source !== 'arxiv') return;
  const key = taxonomyKey(source, source === 'arxiv' ? record.arxivId : record.id, caller);
  if (!key) return;
  const taxonomy: SearchTaxonomy = source === 'arxiv'
    ? { primaryCategory: record.primaryCategory, categories: record.categories }
    : { concepts: record.concepts, topics: record.topics, primaryTopic: record.primaryTopic };
  if (!taxonomy.primaryCategory && !taxonomy.concepts?.length && !taxonomy.topics?.length && !taxonomy.primaryTopic) return;
  try {
    await caches.default.put(key, Response.json(taxonomy, { headers: { 'cache-control': 'public, max-age=600' } }));
  } catch {
    // A failed edge write leaves the provider lookup usable.
  }
}

async function cachedTaxonomy(source: TaxonomySource, id: string | undefined, caller: Request) {
  const key = taxonomyKey(source, id, caller);
  if (!key) return undefined;
  try {
    const hit = await caches.default.match(key);
    return await hit?.json<SearchTaxonomy>();
  } catch {
    return undefined;
  }
}

async function detailPaper(paper: Paper, explicitArxivId: string | undefined, caller: Request, bounds: PaperBounds) {
  const [arxiv, openalex] = await Promise.all([
    cachedTaxonomy('arxiv', explicitArxivId, caller),
    cachedTaxonomy('openalex', paper.id, caller),
  ]);
  const concepts = paper.concepts?.length ? paper.concepts : openalex?.concepts;
  const topics = paper.topics?.length ? paper.topics : openalex?.topics;
  const openAlexNames = subjectNames(concepts, topics);
  const categories = arxiv?.categories ?? openAlexNames;
  const detail = publicPaper({
    ...paper, concepts, topics, categories, allCategories: categories,
    keywords: openAlexNames,
    primaryTopic: paper.primaryTopic ?? openalex?.primaryTopic,
    primaryCategory: paper.primaryCategory || arxiv?.primaryCategory,
  }, bounds);
  // Review status above depends on the sources of the publication evidence.
  // A taxonomy contribution adds no evidence of peer review.
  if (arxiv) detail.sources = { ...paper.sources, enrichedBy: ['arxiv'] };
  return { paper: detail };
}

// A publisher DOI or another site's URL can contain an arXiv-looking substring.
function arxivIdOnWork(work: OpenAlexWork) {
  const direct = normalizeArxivId(work.ids?.arxiv);
  if (direct) return direct.replace(/v\d+$/, '');
  for (const location of [work.primary_location, ...(work.locations || [])]) {
    for (const url of [location?.landing_page_url, location?.pdf_url, location?.id]) {
      if (typeof url !== 'string' || !/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i.test(url)) continue;
      const id = normalizeArxivId(url.split(/[?#]/, 1)[0]);
      if (id) return id.replace(/v\d+$/, '');
    }
  }
  return undefined;
}

// The arXiv id in arXiv's own DOI (10.48550/arXiv.<id>), without its version.
function arxivIdOfDoi(value: unknown) {
  const doi = normalizeDoi(value);
  if (!doi.startsWith(ARXIV_DOI_PREFIX)) return undefined;
  const suffix = doi.slice(ARXIV_DOI_PREFIX.length);
  return suffix && normalizeArxivId(suffix) === suffix ? suffix.replace(/v\d+$/, '') : undefined;
}

// An arXiv DOI identifies the preprint for display and fallback matching.
function arxivIdInDoi(work: OpenAlexWork) {
  return arxivIdOfDoi(work.doi) ?? arxivIdOfDoi(work.ids?.doi);
}

// Search and detail receive the same provider taxonomy. Keep the subject ID
// even when its display name is missing; a name alone cannot identify a topic.
function openAlexIdentityAndTaxonomy(work: OpenAlexWork, explicitArxivId: string | undefined) {
  const id = getPaperIdentity('openalex', work.id || '');
  if (!id) throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  const validTopic = (topic: OpenAlexWork['primary_topic']) =>
    typeof topic?.id === 'string' && /^(?:https:\/\/openalex\.org\/)?T\d+$/i.test(topic.id);
  const topics = Array.isArray(work.topics) ? work.topics.filter(validTopic) : [];
  const concepts = Array.isArray(work.concepts) ? work.concepts.filter(concept =>
    typeof concept?.id === 'string' && /^(?:https:\/\/openalex\.org\/)?C\d+$/i.test(concept.id)) : [];
  const usable = usableOpenAlexConcepts(concepts);
  const categories = subjectNames(usable, topics);
  return { id, arxivId: explicitArxivId ?? arxivIdInDoi(work), topics, primaryTopic: validTopic(work.primary_topic) ? work.primary_topic : undefined,
    concepts: usable, categories, keywords: categories, allCategories: categories };
}

function subjectNames(concepts: Paper['concepts'], topics: Paper['topics']) {
  const subjects = concepts?.length ? concepts : usableOpenAlexConcepts(topics);
  return subjects.flatMap(subject => typeof subject.display_name === 'string' && subject.display_name ? [subject.display_name] : []);
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
  const { results } = await response.json<{ results?: OpenAlexWork[] }>();
  if (!Array.isArray(results)) throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  return results.map(work => {
    const paper = mapOpenAlexWork(work);
    return paper && { ...paper, ...openAlexIdentityAndTaxonomy(work, arxivIdOnWork(work)) };
  });
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

// The entries, in order, that fit in SEARCH_BUDGET_BYTES of JSON. The first
// always goes.
function withinBudget<T>(entries: T[]) {
  const kept: T[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
    if (kept.length > 0 && bytes + size > SEARCH_BUDGET_BYTES) break;
    kept.push(entry);
    bytes += size;
  }
  return kept;
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
  const preprints = foundBy('arxiv');
  const works = foundBy('openalex');
  const ranked = mergeRankedPapers(query, works, preprints, { limit });
  const papers = withinBudget(ranked.map(record => publicPaper(record)));
  await Promise.all(ranked.slice(0, papers.length).map(async paper => {
    const work = works.find(record => record?.id === paper.id);
    const preprint = preprints.find(record => record && record.id === paper.arxivId);
    if (work) await rememberTaxonomy(work, caller);
    if (preprint) await rememberTaxonomy(preprint, caller);
  }));
  const left = ranked.length - papers.length;
  return { query, papers, unavailable, ...(left > 0 ? { omitted: { papers: left } } : {}) };
}

function paperIdArgument(value: unknown) {
  const identity = paperIdentity(value);
  if (!identity) throw new InvalidArguments('id must be a DOI, arXiv id, OpenAlex work id or PubMed id (pmid:123)');
  return identity;
}

function getPaperArguments(args: Arguments) {
  onlyKeys(args, ['id']);
  return paperIdArgument(args.id);
}

// `formatOpenAlexWorkAsPaper` ids a work as `W…`, `mapOpenAlexWork` as
// `openalex:W…`; a search returns the second, so an OpenAlex work keeps one id
// whichever tool returned it and whichever OpenAlex, DOI or PubMed identifier
// found it. An arXiv id that arXiv answers keeps the arXiv id.
//
// The paper page's mapper names the work's primary source as its `journal`
// and that source's host as its `publisher`. A repository (arXiv, SSRN) or a
// platform holds a copy and is no venue, so the paper keeps neither field and
// the client cannot cite the repository as the journal.
function openAlexPaper(work: OpenAlexWork, caller: Request, bounds: PaperBounds) {
  const { journal, publisher, ...paper } = formatOpenAlexWorkAsPaper(work);
  const venue = OPENALEX_VENUE_SOURCE_TYPES.has(String(work.primary_location?.source?.type || ''));
  const explicitArxivId = arxivIdOnWork(work);
  return detailPaper({
    ...paper, ...(venue ? { journal, publisher } : {}),
    ...openAlexIdentityAndTaxonomy(work, explicitArxivId),
  }, explicitArxivId, caller, bounds);
}

// arXiv refuses an agent whenever the beat's current seat is taken, by a
// search's own arXiv miss too, or is not a public one (`handleAgentArxiv`):
// about one try in two on an idle Worker. OpenAlex indexes the same
// preprints, so a refusal or failure asks it for the work at the arXiv
// landing page, as the app's paper page does (`fetchPaperByArxivIdViaOpenAlex`):
// one billed unit, in the agent tier. arXiv's answer that it has no such
// paper stands.
async function getArxivPaper(arxivId: string, caller: Request, env: WorkerEnv, bounds: PaperBounds) {
  let papers: Paper[];
  try {
    papers = await arxivPapers({ id_list: arxivId, max_results: 1 }, caller, env);
  } catch (error) {
    if (!(error instanceof ToolFailure)) {
      // The relay answered but its body was unreadable. Report it without a billed fallback.
      captureWorkerException(error);
      throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
    }
    if (error.details.code === 'INVALID_ARGUMENTS') throw error;
    const work = await ask(handleAgentOpenAlex, '/openalex/works', {
      filter: `locations.landing_page_url:http://arxiv.org/abs/${arxivId}|https://arxiv.org/abs/${arxivId}`,
      per_page: 1,
    }, caller, env)
      .then(response => response.json<{ results?: OpenAlexWork[] }>())
      // The paper's `arxivId` is read off the work, so it has to be this one.
      .then(({ results = [] }) => results.find(found => (arxivIdOnWork(found) ?? arxivIdInDoi(found)) === arxivId))
      .catch((failure: unknown) => {
        recordFailure('get_paper', sourceFailure('openalex', failure));
        return undefined;
      });
    if (!work?.id) throw error;
    // The tool answers, so its failure would leave no line of its own.
    recordFailure('get_paper', { source: 'arxiv', ...error.details });
    return { ...await openAlexPaper(work, caller, bounds), fallback: { from: 'arxiv', to: 'openalex', code: error.details.code } };
  }
  if (!papers[0]) throw new ToolFailure({ code: 'NOT_FOUND' });
  return { paper: publicPaper(papers[0], bounds) };
}

async function paperOf(identity: ReturnType<typeof getPaperArguments>, caller: Request, env: WorkerEnv, bounds: PaperBounds) {
  if (identity.type === 'arxiv') return getArxivPaper(identity.value.replace(/v\d+$/, ''), caller, env, bounds);
  return openAlexPaper(await openAlexWork(identity, caller, env), caller, bounds);
}

const getPaper = (identity: ReturnType<typeof getPaperArguments>, caller: Request, env: WorkerEnv) => paperOf(identity, caller, env, PAPER_BOUNDS);

// The OpenAlex work a DOI, PubMed id or OpenAlex work id names.
async function openAlexWork(identity: ReturnType<typeof getPaperArguments>, caller: Request, env: WorkerEnv) {
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
  return work;
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

// ─── Account tools ───

interface AccountCall { account: Account; caller: Request; env: WorkerEnv }

// A recommendation, a graph neighbour and a list's paper are returned by
// name: identifiers, title, first authors and a date. Their records establish
// little more. Semantic Scholar's gives no review status and often names a
// repository as the venue, OpenCitations' has only a work type to read a
// status from, and a saved copy holds what a card showed. `get_paper` returns
// the paper itself.
interface NamedPaper { id?: unknown; title?: unknown; authors?: unknown; year?: unknown; published?: unknown; doi?: unknown; arxivId?: unknown }

function namedPaper(paper: NamedPaper, maxAuthors: number) {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const names = (Array.isArray(paper.authors) ? paper.authors : [])
    .flatMap((author: unknown) => text(typeof author === 'string' ? author : (author as { name?: unknown } | null)?.name) ?? []);
  const [id, title, published, doi, arxivId] = [paper.id, paper.title, paper.published, paper.doi, paper.arxivId].map(text);
  return {
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
    ...(names.length > 0 ? { authors: names.slice(0, maxAuthors) } : {}),
    ...(typeof paper.year === 'number' && Number.isInteger(paper.year) ? { year: paper.year } : {}),
    ...(published ? { published } : {}),
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(names.length > maxAuthors ? { omitted: { authors: names.length - maxAuthors } } : {}),
  };
}

// arXiv's own DOI is not a publisher's: Semantic Scholar does not resolve it
// (`getSemanticScholarPaperId` in src/services/related-papers-service.ts),
// and the paper it names is asked for by its arXiv id.
const publisherDoi = (doi: string | undefined) => (doi && !arxivIdOfDoi(doi) ? doi : undefined);

// The DOI and arXiv id of the paper an id names. `/related` and
// `/citation-graph` take no other identifier, so an OpenAlex or PubMed id is
// looked up first: one unbilled OpenAlex work, as `get_paper` asks for it.
// A paper known by its arXiv id alone has arXiv's DOI, as the app's paper
// page asks OpenAlex for it (`workUrlForReference` in src/services/open-alex-service.ts).
async function doiAndArxivId(identity: ReturnType<typeof paperIdArgument>, caller: Request, env: WorkerEnv) {
  let doi: string | undefined;
  let arxivId: string | undefined;
  if (identity.type === 'doi') doi = identity.value;
  else if (identity.type === 'arxiv') arxivId = identity.value.replace(/v\d+$/, '');
  else {
    const work = await openAlexWork(identity, caller, env);
    doi = normalizeDoi(work.doi || work.ids?.doi) || undefined;
    arxivId = arxivIdOnWork(work);
  }
  arxivId ??= arxivIdOfDoi(doi);
  return { doi: doi ?? (arxivId ? `${ARXIV_DOI_PREFIX}${arxivId}` : undefined), arxivId };
}

function similarArguments(args: Arguments) {
  onlyKeys(args, ['id', 'limit']);
  return { identity: paperIdArgument(args.id), limit: integerArgument(args.limit, MAX_RESULTS, 'limit') };
}

// What a tool reads of a Semantic Scholar record; `/related` asks for more.
interface Recommendation { title?: unknown; authors?: unknown; year?: unknown; externalIds?: { DOI?: unknown; ArXiv?: unknown } | null }

function recommendation(record: Recommendation) {
  const doi = normalizeDoi(record.externalIds?.DOI) || undefined;
  const arxivId = normalizeArxivId(record.externalIds?.ArXiv).replace(/v\d+$/, '') || arxivIdOfDoi(doi);
  return namedPaper({ id: publisherDoi(doi) ?? arxivId ?? doi, title: record.title, authors: record.authors, year: record.year, doi, arxivId }, MAX_AUTHORS);
}

// `/related` answers from the cache the app's requests fill, where both ask
// with the same identifier: the recommendations for a paper are the same for
// every reader. The cache key keeps the identifier's case, a tool sends a DOI
// lowercased and the app sends it as its record holds it, so a DOI with
// capitals has an entry for each. A miss is charged to the account, as a
// signed-in reader's is.
async function findSimilarPapers({ identity, limit }: ReturnType<typeof similarArguments>, { account, caller, env }: AccountCall) {
  const { doi, arxivId } = await doiAndArxivId(identity, caller, env);
  const paperId = publisherDoi(doi) ? `DOI:${doi}` : arxivId ? `ARXIV:${arxivId}` : '';
  if (!paperId) throw new ToolFailure({ code: 'INVALID_ARGUMENTS', message: 'This paper has no DOI or arXiv id, and Semantic Scholar is asked by one of them' });
  const response = await ask((request, bindings) => handleRelated(request, bindings, account), '/related', { paper_id: paperId }, caller, env);
  const answer = await response.json<{ recommendedPapers?: Array<Recommendation | null>; code?: string }>();
  // No recommendations is an answer; a paper Semantic Scholar does not hold has none to give.
  if (answer.code === 'PAPER_NOT_INDEXED') throw new ToolFailure({ code: 'PAPER_NOT_INDEXED' });
  if (!Array.isArray(answer.recommendedPapers)) throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  const papers = answer.recommendedPapers.flatMap(record => (record && typeof record === 'object' ? [recommendation(record)] : []))
    .filter(paper => paper.title || paper.id);
  return { papers: papers.slice(0, limit), ...(papers.length > limit ? { omitted: { papers: papers.length - limit } } : {}) };
}

interface CitationGraph {
  references?: Partial<Paper>[];
  citations?: Partial<Paper>[];
  counts?: { references?: number; citations?: number };
  source?: string;
  partial?: boolean;
  degraded?: boolean;
}

function neighbour(paper: Partial<Paper>) {
  return {
    ...namedPaper({ id: paper.id, title: paper.title, authors: paper.authors, year: paper.year, doi: paper.doi }, MAX_LISTED_AUTHORS),
    ...(paper.citationCountKnown === true ? { citationCount: paper.citationCount } : {}),
  };
}

// `/citation-graph` bills its OpenAlex misses in the `exploration` tier for
// every caller, and charges a miss to the account as it does a reader's.
async function getCitationGraph(identity: ReturnType<typeof getPaperArguments>, { account, caller, env }: AccountCall) {
  const { doi } = await doiAndArxivId(identity, caller, env);
  if (!doi) throw new ToolFailure({ code: 'INVALID_ARGUMENTS', message: 'This paper has no DOI, and the citation graph is asked by DOI' });
  const response = await ask((request, bindings) => handleCitationGraph(request, bindings, account), '/citation-graph', { doi, limit: MAX_NEIGHBOURS }, caller, env);
  const graph = await response.json<CitationGraph>();
  if (!Array.isArray(graph.references) || !Array.isArray(graph.citations)) throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  const references = graph.references.slice(0, MAX_NEIGHBOURS).map(neighbour);
  const citations = graph.citations.slice(0, MAX_NEIGHBOURS).map(neighbour);
  const counts = {
    references: Math.max(Number(graph.counts?.references) || 0, graph.references.length),
    citations: Math.max(Number(graph.counts?.citations) || 0, graph.citations.length),
  };
  const omitted = {
    ...(counts.references > references.length ? { references: counts.references - references.length } : {}),
    ...(counts.citations > citations.length ? { citations: counts.citations - citations.length } : {}),
  };
  return {
    doi,
    references,
    citations,
    counts,
    ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
    ...(graph.source ? { source: graph.source } : {}),
    partial: graph.partial === true,
    degraded: graph.degraded === true,
  };
}

// Firestore, read with the Worker's service account. Every path a tool reads
// starts at `users/<uid>`, and the uid is the one the agent token names.
function accountStore(env: WorkerEnv) {
  if (!isServiceAccountConfigured(env)) throw new ToolFailure({ code: 'ACCOUNT_DATA_NOT_CONFIGURED' });
  return createFirestoreAdmin(env);
}

async function readStore<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    // Firestore, or the token exchange before it, refused or did not answer.
    captureWorkerException(error);
    throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  }
}

interface StoredList { name?: unknown; paperIds?: unknown; publicShareId?: unknown; updatedAt?: unknown }

// Whether Firestore takes `id` as the last segment of a document's path: `.`
// and `..` would address another document (`documentName` in
// firestore-admin.ts), and Firestore reserves `__…__` and answers it with a
// 400, which a tool would report as an outage.
function isDocumentId(id: unknown, maxLength: number): id is string {
  return typeof id === 'string' && id !== '' && id !== '.' && id !== '..' && id.length <= maxLength && !/^__.*__$/.test(id);
}

// The rules check only that `paperIds` is a list of at most 500 entries, so
// each entry is checked here before it becomes a document name.
function listPaperIds(list: StoredList) {
  if (!Array.isArray(list.paperIds)) return null;
  return list.paperIds.filter((id): id is string => isDocumentId(id, MAX_PAPER_ID_LENGTH));
}

// The page of a list in the app, which opens for its account only (`/lists/:listId` in src/app.tsx).
const listUrl = (id: string) => `${DEFAULT_PUBLIC_ORIGIN}/lists/${encodeURIComponent(id)}`;
const feedUrl = (id: string) => `${DEFAULT_PUBLIC_ORIGIN}/feeds/${id}`;

function listSummary(id: string, list: StoredList) {
  const paperIds = listPaperIds(list);
  return {
    id,
    ...(typeof list.name === 'string' && list.name ? { name: list.name } : {}),
    ...(paperIds ? { paperCount: paperIds.length } : {}),
    // The Worker sets the field in the commit that creates the public copy and
    // clears it in the one that deletes it, so its absence says private.
    public: typeof list.publicShareId === 'string' && list.publicShareId !== '',
    ...(list.updatedAt instanceof Date && !Number.isNaN(list.updatedAt.getTime()) ? { updatedAt: list.updatedAt.toISOString() } : {}),
    url: listUrl(id),
  };
}

function noArguments(args: Arguments) {
  onlyKeys(args, []);
  return null;
}

async function listMyLists(_arguments: null, { account, env }: AccountCall) {
  const store = accountStore(env);
  const lists = { parentSegments: ['users', account.uid], collectionId: 'lists' };
  const found = await readStore(() => store.runQuery<StoredList>({ ...lists, select: ['name', 'paperIds', 'publicShareId', 'updatedAt'], limit: MAX_LISTS + 1 }));
  const total = found.length > MAX_LISTS ? await readStore(() => store.countQuery(lists)) : found.length;
  return {
    lists: found.slice(0, MAX_LISTS).map(({ id, data }) => listSummary(id, data)),
    ...(total > MAX_LISTS ? { omitted: { lists: total - MAX_LISTS } } : {}),
  };
}

function listArguments(args: Arguments) {
  onlyKeys(args, ['listId']);
  const listId = typeof args.listId === 'string' ? args.listId.trim() : '';
  if (!isDocumentId(listId, MAX_LIST_ID_LENGTH) || listId.includes('/')) {
    throw new InvalidArguments('listId must be a list id from list_my_lists');
  }
  return { listId };
}

interface SavedCopy { title?: unknown; authors?: unknown; published?: unknown; doi?: unknown; arxivId?: unknown }

async function getList({ listId }: ReturnType<typeof listArguments>, { account, env }: AccountCall) {
  const store = accountStore(env);
  const list = await readStore(() => store.getDocument<StoredList>(['users', account.uid, 'lists', listId]));
  if (!list) throw new ToolFailure({ code: 'NOT_FOUND' });
  const summary = listSummary(listId, list);
  const paperIds = listPaperIds(list);
  // A list without a readable `paperIds` has no known papers, which is not none.
  if (!paperIds) return summary;
  const asked = paperIds.slice(0, MAX_LIST_PAPERS);
  const copies = await readStore(() => store.batchGet<SavedCopy>(asked.map(id => ['users', account.uid, 'savedPapers', encodeFirestoreDocId(id)])));
  const papers = withinBudget(asked.map((id, index) => {
    const copy = copies[index];
    if (!copy) return { id, metadata: 'unavailable' };
    // The app stores a paper without a title under its own id (`buildSavedPaperPayload`).
    return namedPaper({ ...copy, id, title: copy.title === id ? undefined : copy.title }, MAX_LISTED_AUTHORS);
  }));
  return { ...summary, papers, ...(paperIds.length > papers.length ? { omitted: { papers: paperIds.length - papers.length } } : {}) };
}

async function listMyFeeds(_arguments: null, { account, env }: AccountCall) {
  const store = accountStore(env);
  const settings = await readStore(() => store.getDocument<{ feeds?: unknown }>(['users', account.uid, 'settings', 'customFeeds']));
  // An account that never made a feed has no such document.
  return { feeds: parseCustomFeeds(settings?.feeds).map(feed => ({ ...feed, url: feedUrl(feed.id) })) };
}

// ─── Account write tools ───
//
// The caller is an AI agent, and text inside a paper may have steered it. So
// these tools make private lists and custom feeds and add papers to private
// lists, and nothing else: none publishes, deletes, renames or reorders.
//
// The service account's writes pass no security rule, so each document is
// written in the shape the owner's client writes and `firestore.rules` accepts
// on update. A field outside the rules' key list, or one of another type,
// would refuse every later edit the owner made to their own document.
//
// No tool records an interaction (`users/{uid}/interactions`), so an agent
// filing a paper teaches the reader's recommendations nothing.

// What a tool reserved of the account's day, given back when its write did
// not happen. `unused` gives back that many units; without it, all of them.
type Release = (unused?: number) => Promise<void>;

async function reserveDaily(kind: keyof typeof DAILY_WRITES, amount: number, { account, env }: AccountCall): Promise<Release> {
  const { namespace, limit, code } = DAILY_WRITES[kind];
  const day = await reserveAccountDay(account.uid, env, namespace, limit, amount);
  if (day.reading.code === 'CALLER_IDENTITY_NOT_CONFIGURED' || day.reading.code === 'QUOTA_LEDGER_NOT_CONFIGURED') {
    throw new ToolFailure({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' });
  }
  if (day.reading.code) throw new ToolFailure({ code: 'QUOTA_LEDGER_UNAVAILABLE', retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
  if (!day.reading.accepted) {
    throw new ToolFailure({ code, limit, remaining: Math.max(0, limit - (day.reading.subjectUsage ?? limit)), retryAfterSeconds: Number(day.retryAfter) });
  }
  return async (unused = amount) => {
    if (unused <= 0) return;
    // A release that fails leaves the account's day that much shorter.
    await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, { ...day.reservation!, amount: unused }).catch(captureWorkerException);
  };
}

// Each paper or entity a write tool looks up is one more call of the
// account's minute, so a call that names 25 papers costs what 25 get_paper
// calls would and cannot ask the providers for more than they could.
async function countLookups(lookups: number, { account, env }: AccountCall) {
  if (lookups <= 0) return;
  const minute = await reserveAccountMinute(account.uid, env, MCP_CALLER_MINUTE.namespace, MCP_CALLER_MINUTE.limit, lookups);
  if (minute.reading.code === 'CALLER_IDENTITY_NOT_CONFIGURED' || minute.reading.code === 'QUOTA_LEDGER_NOT_CONFIGURED') {
    throw new ToolFailure({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' });
  }
  if (minute.reading.code) throw new ToolFailure({ code: 'QUOTA_LEDGER_UNAVAILABLE', retryAfterSeconds: Number(minute.retryAfter) });
  if (!minute.reading.accepted) throw new ToolFailure({ code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: Number(minute.retryAfter) });
}

// Runs `lookup` over `items`, LOOKUP_CONCURRENCY at a time, and gives each
// item its answer or its failure as a tool code. An item whose answer has not
// come when the deadline passes is LOOKUP_TIMEOUT; its lookup may still end,
// and nothing reads it.
async function lookUpAll<T, R>(tool: string, items: T[], lookup: (item: T) => Promise<R>) {
  const deadline = Date.now() + LOOKUP_DEADLINE_MS;
  const outcomes: Array<{ found: R } | { failure: Record<string, unknown> }> = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const left = deadline - Date.now();
      if (left <= 0) {
        outcomes[index] = { failure: { code: 'LOOKUP_TIMEOUT' } };
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<{ failure: Record<string, unknown> }>(resolve => {
        timer = setTimeout(() => resolve({ failure: { code: 'LOOKUP_TIMEOUT' } }), left);
      });
      const answered = lookup(items[index]).then(found => ({ found }), (error: unknown) => {
        // The lookup's refusal or outage is logged as the same failure of get_paper is.
        const failure = error instanceof ToolFailure ? error.details : sourceFailure('lookup', error);
        recordFailure(tool, failure);
        return { failure: { code: failure.code, ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }) } };
      });
      outcomes[index] = await Promise.race([answered, late]);
      clearTimeout(timer);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, items.length) }, worker));
  return outcomes;
}

function requestIdArgument(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new InvalidArguments('requestId must be 8 to 64 letters, digits, "_" or "-"');
  return value;
}

// The id a write makes its document under. With a requestId it is a hash of
// the account, the kind of document and the requestId, so the same call made
// again names the same document; without one it is random. Lowercase hex, the
// alphabet of a feed id (`FEED_ID` in src/utils/custom-feeds.ts).
async function writeId(kind: 'list' | 'feed', uid: string, requestId: string | undefined, length: number) {
  const bytes = requestId === undefined
    ? crypto.getRandomValues(new Uint8Array(length / 2))
    : new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`papertok-mcp:${kind}:${uid}:${requestId}`)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}

type PaperIdentity = ReturnType<typeof paperIdArgument>;
interface PaperCandidate { asked: string; identity: PaperIdentity }
interface LeftOut { id: string; code: string; retryAfterSeconds?: unknown }
// A paper a lookup found: the id it is filed under, and the copy saved with the account.
interface FoundPaper { asked: string; id: string; copy: Record<string, unknown> }

// The papers a call names, each read as get_paper reads its id. An entry that
// is no identifier is left out with INVALID_ID, and one that names a paper
// already named with DUPLICATE; the call goes on with the rest.
function paperCandidates(value: unknown, { required }: { required: boolean }) {
  if (value === undefined && !required) return { candidates: [] as PaperCandidate[], leftOut: [] as LeftOut[], asked: 0 };
  if (!Array.isArray(value) || value.length > MAX_WRITE_PAPERS || (required && value.length === 0)
    || value.some(id => typeof id !== 'string' || id.trim() === '' || id.length > 300)) {
    throw new InvalidArguments(`paperIds must list ${required ? '1' : '0'} to ${MAX_WRITE_PAPERS} paper ids`);
  }
  const candidates: PaperCandidate[] = [];
  const leftOut: LeftOut[] = [];
  const seen = new Set<string>();
  for (const asked of value as string[]) {
    const identity = paperIdentity(asked);
    const key = identity && `${identity.type}:${identity.type === 'arxiv' ? identity.value.replace(/v\d+$/, '') : identity.value}`;
    if (!identity || !key) leftOut.push({ id: asked, code: 'INVALID_ID' });
    else if (seen.has(key)) leftOut.push({ id: asked, code: 'DUPLICATE' });
    else {
      seen.add(key);
      candidates.push({ asked, identity });
    }
  }
  return { candidates, leftOut, asked: value.length };
}

// One paper, looked up as get_paper looks it up: the same routes, budgets and
// pacing, and the same record, with all of its categories (COPY_BOUNDS). The
// app files a paper under its record's id: the arXiv id of an arXiv record,
// `openalex:W…` of an OpenAlex one. A paper asked for by arXiv id that
// OpenAlex answered, because arXiv's pacing refused the lookup, is filed under
// the arXiv id asked for, as the feed files that preprint: the work's own
// record names that id (`getArxivPaper`).
async function findPaper({ asked, identity }: PaperCandidate, caller: Request, env: WorkerEnv): Promise<FoundPaper> {
  const answer: { paper: ReturnType<typeof publicPaper>; fallback?: unknown } = await paperOf(identity, caller, env, COPY_BOUNDS);
  const filedByArxivId = identity.type === 'arxiv' && Boolean(answer.fallback);
  const id = filedByArxivId ? identity.value.replace(/v\d+$/, '') : answer.paper.id;
  if (!isDocumentId(id, MAX_PAPER_ID_LENGTH)) throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  // A copy filed under an arXiv id says which arXiv categories the preprint
  // has. OpenAlex's record of it names OpenAlex's subjects, which are not
  // those: unless arXiv's own are known (a search left them at the edge), the
  // copy's categories stay unknown, and it keeps OpenAlex's `primaryTopic`.
  const { categories, primaryCategory, ...uncategorized } = answer.paper;
  const subjectsAreArxivs = answer.paper.taxonomySources?.categories === 'arxiv';
  const record = filedByArxivId && !subjectsAreArxivs ? uncategorized : { ...uncategorized, categories, primaryCategory };
  // The copy `users/{uid}/savedPapers` keeps, built as the app builds it, so it
  // passes the rules' shape. Through JSON, so a key the builder left undefined
  // is absent and not a null the rules refuse. Without `savedAt`: that field
  // stamps the reader's own save.
  const authors = (answer.paper.authors || []).flatMap(author => (typeof author === 'string' ? [author] : author.name ? [author.name] : []));
  const copy = JSON.parse(JSON.stringify(buildSavedPaperPayload({ ...record, id, authors }))) as Record<string, unknown>;
  return { asked, id, copy };
}

async function findPapers(tool: string, candidates: PaperCandidate[], leftOut: LeftOut[], { caller, env }: AccountCall) {
  const outcomes = await lookUpAll(tool, candidates, candidate => findPaper(candidate, caller, env));
  const found: FoundPaper[] = [];
  outcomes.forEach((outcome, index) => {
    const { asked } = candidates[index];
    if ('failure' in outcome) leftOut.push({ id: asked, ...outcome.failure } as LeftOut);
    // Two identifiers of one paper, a DOI and its arXiv id say.
    else if (found.some(paper => paper.id === outcome.found.id)) leftOut.push({ id: asked, code: 'DUPLICATE' });
    else found.push(outcome.found);
  });
  return found;
}

// A document's name as a commit's body carries it. `store.name` escapes each
// segment for a URL, and a paper's document name holds `:` and `%`: escaped
// again in a body, the write would land on a document of another name.
const writeName = (store: FirestoreAdmin, path: string[]) => store.name(path).split('/').map(decodeURIComponent).join('/');

// The writes that save the copies of `papers` the account does not hold yet.
// A copy it holds is the reader's and stays as it is.
async function copyWrites(store: FirestoreAdmin, uid: string, papers: FoundPaper[]): Promise<FirestoreWrite[]> {
  const paths = papers.map(paper => ['users', uid, 'savedPapers', encodeFirestoreDocId(paper.id)]);
  const held = await readStore(() => store.batchGet(paths));
  return papers.flatMap((paper, index) => (held[index] ? [] : [mergeWrite(writeName(store, paths[index]), paper.copy, { mustExist: false })]));
}

// Whether the commit landed. `false`: a precondition failed, so nothing was
// written and the document it guards has changed or already exists.
async function commitWrites(store: FirestoreAdmin, writes: FirestoreWrite[], transaction?: string) {
  try {
    await store.commit(writes, transaction);
    return true;
  } catch (error) {
    if (error instanceof FirestoreAdminError && error.code === 'FIRESTORE_PRECONDITION_FAILED') return false;
    captureWorkerException(error);
    throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  }
}

const addedPaper = ({ id, copy }: FoundPaper) => ({ id, ...(typeof copy.title === 'string' && copy.title !== id ? { title: copy.title } : {}) });

function listName(value: unknown) {
  // What the name field of the app can hold: one line, trimmed.
  const name = typeof value === 'string' ? value.replace(/[\p{Cc}\s]+/gu, ' ').trim() : '';
  if (!name || name.length > MAX_LIST_NAME_LENGTH) throw new InvalidArguments(`name must be 1 to ${MAX_LIST_NAME_LENGTH} characters`);
  return name;
}

function createListArguments(args: Arguments) {
  onlyKeys(args, ['name', 'paperIds', 'requestId']);
  return { name: listName(args.name), papers: paperCandidates(args.paperIds, { required: false }), requestId: requestIdArgument(args.requestId) };
}

async function createList({ name, papers, requestId }: ReturnType<typeof createListArguments>, call: AccountCall) {
  const { account } = call;
  const store = accountStore(call.env);
  const id = `list_${await writeId('list', account.uid, requestId, 24)}`;
  const path = ['users', account.uid, 'lists', id];
  const existing = async () => {
    const list = await readStore(() => store.getDocument<StoredList>(path));
    return list && { list: listSummary(id, list), existing: true };
  };
  // The same call made again: the list it made stands, and nothing is spent.
  const made = requestId === undefined ? null : await existing();
  if (made) return made;
  const leftOut = [...papers.leftOut];
  if (papers.asked > 0 && papers.candidates.length === 0) throw new ToolFailure({ code: 'NO_PAPERS_ADDED', notAdded: leftOut });

  const releases: Release[] = [];
  let written = false;
  try {
    releases.push(await reserveDaily('lists', 1, call));
    if (papers.candidates.length > 0) releases.push(await reserveDaily('papers', papers.candidates.length, call));
    await countLookups(papers.candidates.length, call);
    const found = await findPapers('create_list', papers.candidates, leftOut, call);
    if (papers.asked > 0 && found.length === 0) throw new ToolFailure({ code: 'NO_PAPERS_ADDED', notAdded: leftOut });
    const now = new Date(Date.now());
    // The fields `handleCreateList` writes (src/components/lists/lists-page.tsx)
    // and no other: `createdAt` is a string there, and the rules take
    // `updatedAt` only as a timestamp. Without `color` the app paints the
    // list by its id (`resolveListColorId`). Never `publicShareId`.
    const list = { id, name, emoji: CREATE_LIST_FORM_INITIAL.icon, paperIds: found.map(paper => paper.id), createdAt: now.toISOString(), updatedAt: now };
    const writes = [createWrite(writeName(store, path), list), ...await copyWrites(store, account.uid, found)];
    if (!await commitWrites(store, writes)) {
      // The id was taken while this call ran: its own earlier attempt landed.
      const raced = await existing();
      if (raced) return raced;
      throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
    }
    written = true;
    await releases[1]?.(papers.candidates.length - found.length);
    return { list: { id, name, paperCount: found.length, public: false, url: listUrl(id) }, added: found.map(addedPaper), notAdded: leftOut };
  } finally {
    if (!written) await Promise.all(releases.map(release => release()));
  }
}

function addPapersArguments(args: Arguments) {
  onlyKeys(args, ['listId', 'paperIds']);
  return { ...listArguments({ listId: args.listId }), papers: paperCandidates(args.paperIds, { required: true }) };
}

// The list as it stands, with the version a write has to find it at.
async function writableList(store: FirestoreAdmin, path: string[]) {
  const list = await readStore(() => store.getDocument<StoredList, true>(path, { withMeta: true }));
  if (!list) throw new ToolFailure({ code: 'NOT_FOUND' });
  // The app keeps a published list's public copy in step with it; a write
  // from here would leave that copy behind.
  if (list.data.publicShareId !== undefined && list.data.publicShareId !== null) throw new ToolFailure({ code: 'LIST_IS_PUBLIC' });
  if (!Array.isArray(list.data.paperIds) || !list.updateTime) throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
  return { paperIds: list.data.paperIds as unknown[], name: list.data.name, updateTime: list.updateTime };
}

async function addPapersToList({ listId, papers }: ReturnType<typeof addPapersArguments>, call: AccountCall) {
  const { account } = call;
  const store = accountStore(call.env);
  const path = ['users', account.uid, 'lists', listId];
  let list = await writableList(store, path);
  const leftOut = [...papers.leftOut];
  if (papers.candidates.length === 0) throw new ToolFailure({ code: 'NO_PAPERS_ADDED', notAdded: leftOut });
  if (list.paperIds.length >= MAX_LIST_PAPER_IDS) throw new ToolFailure({ code: 'LIST_FULL', limit: MAX_LIST_PAPER_IDS });

  const release = await reserveDaily('papers', papers.candidates.length, call);
  let added: FoundPaper[] = [];
  let written = false;
  try {
    await countLookups(papers.candidates.length, call);
    const found = await findPapers('add_papers_to_list', papers.candidates, leftOut, call);
    // Twice at most: a list edited between its read and the write is read again.
    for (let attempt = 0; ; attempt += 1) {
      const fresh = found.filter(paper => !list.paperIds.includes(paper.id));
      added = fresh.slice(0, MAX_LIST_PAPER_IDS - list.paperIds.length);
      if (added.length === 0) break;
      const writes = [
        mergeWrite(writeName(store, path), { paperIds: [...list.paperIds, ...added.map(paper => paper.id)], updatedAt: new Date(Date.now()) }, { updateTime: list.updateTime }),
        ...await copyWrites(store, account.uid, added),
      ];
      if (await commitWrites(store, writes)) {
        written = true;
        break;
      }
      if (attempt === 1) throw new ToolFailure({ code: 'LIST_CHANGED' });
      list = await writableList(store, path);
    }
    const notAdded = [
      ...leftOut,
      ...found.filter(paper => !added.includes(paper)).map(paper => ({ id: paper.asked, code: list.paperIds.includes(paper.id) ? 'ALREADY_IN_LIST' : 'LIST_FULL' })),
    ];
    if (!written && !notAdded.some(entry => entry.code === 'ALREADY_IN_LIST')) throw new ToolFailure({ code: 'NO_PAPERS_ADDED', notAdded });
    await release(papers.candidates.length - added.length);
    const paperCount = list.paperIds.length + added.length;
    return {
      list: { id: listId, ...(typeof list.name === 'string' && list.name ? { name: list.name } : {}), paperCount, public: false, url: listUrl(listId) },
      added: added.map(addedPaper),
      notAdded,
    };
  } catch (error) {
    if (!written) await release();
    throw error;
  }
}

const FEED_INCLUDES = ['topics', 'authors'] as const;
type FeedInclude = typeof FEED_INCLUDES[number];
// Read with a label that is never stored, to check the kind and id of an
// entity before OpenAlex is asked for its name.
const UNNAMED = 'unnamed';

function createFeedArguments(args: Arguments) {
  onlyKeys(args, ['name', 'order', 'fromPaperId', 'include', 'ingredients', 'requestId']);
  const name = typeof args.name === 'string' ? args.name.replace(/[\p{Cc}\s]+/gu, ' ').trim() : '';
  if (feedNameProblem(name, []) !== null) throw new InvalidArguments(`name must be 1 to ${MAX_FEED_NAME_LENGTH} characters`);
  // "Newest first" is the order the app's feed window opens on.
  const asked = args.order ?? 'newest';
  if (asked !== 'newest' && asked !== 'best') throw new InvalidArguments('order must be "newest" or "best"');
  const order: CustomFeedOrder = asked;
  if ((args.fromPaperId === undefined) === (args.ingredients === undefined)) throw new InvalidArguments('give either fromPaperId or ingredients');
  const requestId = requestIdArgument(args.requestId);
  if (args.fromPaperId !== undefined) {
    const include = args.include ?? ['topics'];
    if (!Array.isArray(include) || include.length === 0 || new Set(include).size !== include.length
      || include.some(part => !(FEED_INCLUDES as readonly unknown[]).includes(part))) {
      throw new InvalidArguments('include must list "topics" and/or "authors" once each');
    }
    return { name, order, requestId, from: { paper: paperIdArgument(args.fromPaperId), include: include as FeedInclude[] } };
  }
  if (args.include !== undefined) throw new InvalidArguments('include goes with fromPaperId');
  if (!Array.isArray(args.ingredients) || args.ingredients.length === 0 || args.ingredients.length > MAX_FEED_INGREDIENTS) {
    throw new InvalidArguments(`ingredients must list 1 to ${MAX_FEED_INGREDIENTS} ingredients`);
  }
  return { name, order, requestId, ingredients: args.ingredients as unknown[] };
}

type FeedArguments = ReturnType<typeof createFeedArguments>;
// An ingredient left out of a feed: by its place in `ingredients` when it
// could not be read, otherwise as it was read.
interface IngredientLeftOut { index?: number; ingredient?: Partial<FeedIngredient>; code: string; retryAfterSeconds?: unknown }
type EntityIngredient = Extract<FeedIngredient, { label: string }>;

const OPENALEX_COLLECTION = { topic: 'topics', author: 'authors', journal: 'sources' } as const;

// The name OpenAlex gives the entity, read through the relay in the agent
// tier (one entity by id, which OpenAlex does not bill). The caller's label is
// never stored: a model can write any name beside a real id.
async function confirmedEntity({ kind, id }: Pick<EntityIngredient, 'kind' | 'id'>, caller: Request, env: WorkerEnv): Promise<EntityIngredient> {
  // A `C…` id is a concept, which the app also follows as a research topic.
  const collection = kind === 'topic' && id.startsWith('C') ? 'concepts' : OPENALEX_COLLECTION[kind];
  const response = await ask(handleAgentOpenAlex, `/openalex/${collection}/${id}`, { select: 'id,display_name' }, caller, env);
  const entity = await response.json<{ id?: unknown; display_name?: unknown }>();
  // OpenAlex answers a merged entity's old id with the entity it became.
  const confirmed = typeof entity.id === 'string' && entity.id.split('/').pop() === id
    ? parseFeedIngredient({ kind, id, label: entity.display_name }) : null;
  if (!confirmed || !('label' in confirmed)) throw new ToolFailure({ code: 'ENTITY_NOT_CONFIRMED' });
  return confirmed;
}

// The ingredients the caller listed, each checked: an area, category or
// keyword against the app's own rules, and a topic, author or journal against
// OpenAlex, up to MAX_ENTITY_LOOKUPS of them.
async function listedIngredients(listed: unknown[], leftOut: IngredientLeftOut[], call: AccountCall) {
  const read = listed.map((raw, index) => {
    const entity = raw && typeof raw === 'object' && ['topic', 'author', 'journal'].includes(String((raw as { kind?: unknown }).kind));
    const ingredient = parseFeedIngredient(entity ? { ...raw, label: UNNAMED } : raw);
    return { index, ingredient, entity: ingredient !== null && 'label' in ingredient ? ingredient : null };
  });
  const lookups = read.flatMap(({ entity }) => (entity ? [entity] : [])).slice(0, MAX_ENTITY_LOOKUPS);
  await countLookups(lookups.length, call);
  const outcomes = await lookUpAll('create_feed', lookups, entity => confirmedEntity(entity, call.caller, call.env));
  const ingredients: FeedIngredient[] = [];
  for (const { index, ingredient, entity } of read) {
    if (!ingredient) leftOut.push({ index, code: 'INVALID_INGREDIENT' });
    else if (!entity) ingredients.push(ingredient);
    else {
      const named = { index, ingredient: { kind: entity.kind, id: entity.id } };
      const outcome = outcomes[lookups.indexOf(entity)];
      if (!outcome) leftOut.push({ ...named, code: 'TOO_MANY_LOOKUPS' });
      else if ('failure' in outcome) leftOut.push({ ...named, ...outcome.failure } as IngredientLeftOut);
      else ingredients.push(outcome.found);
    }
  }
  return ingredients;
}

// The ingredients a paper gives: its OpenAlex topics by their own ids and
// names, the primary one first, and its first authors when asked. The model
// names the paper and no identifier of a topic or an author.
async function paperIngredients({ paper, include }: NonNullable<FeedArguments['from']>, call: AccountCall) {
  await countLookups(1, call);
  // A paper known by its arXiv id is asked for by arXiv's own DOI, one unbilled work (`doiAndArxivId`).
  const identity = paper.type === 'arxiv' ? { type: 'doi', value: `${ARXIV_DOI_PREFIX}${paper.value.replace(/v\d+$/, '')}` } : paper;
  const work = await openAlexWork(identity, call.caller, call.env);
  const ingredients: FeedIngredient[] = [];
  const add = (raw: unknown, among: FeedIngredient['kind'], max: number) => {
    const ingredient = parseFeedIngredient(raw);
    const held = ingredients.filter(other => other.kind === among);
    if (ingredient && 'id' in ingredient && held.length < max && !held.some(other => 'id' in other && other.id === ingredient.id)) ingredients.push(ingredient);
  };
  if (include.includes('topics')) {
    for (const topic of [work.primary_topic, ...(Array.isArray(work.topics) ? work.topics : [])]) {
      add({ kind: 'topic', id: topic?.id, label: topic?.display_name }, 'topic', MAX_PAPER_FEED_TOPICS);
    }
  }
  if (include.includes('authors')) {
    for (const authorship of Array.isArray(work.authorships) ? work.authorships : []) {
      add({ kind: 'author', id: authorship?.author?.id, label: authorship?.author?.display_name }, 'author', MAX_PAPER_FEED_AUTHORS);
    }
  }
  return ingredients;
}

const publicFeed = (feed: CustomFeed) => ({ ...feed, url: feedUrl(feed.id) });

// One attempt to add the feed inside a transaction on the account's feeds
// document, so the limit of feeds, the names and the account's ceilings are
// checked against the list the write replaces. `null`: another write to the
// document won, and nothing was written.
async function addFeedOnce(store: FirestoreAdmin, uid: string, id: string, { name, order }: FeedArguments, ingredients: FeedIngredient[], leftOut: IngredientLeftOut[]) {
  const path = ['users', uid, 'settings', 'customFeeds'];
  const transaction = await readStore(() => store.beginTransaction());
  let committed = false;
  try {
    let stored: { feeds?: unknown } | null;
    try {
      [stored] = await store.batchGet<{ feeds?: unknown }>([path], transaction);
    } catch (error) {
      if (error instanceof FirestoreAdminError && error.code === 'FIRESTORE_PRECONDITION_FAILED') return null;
      captureWorkerException(error);
      throw new ToolFailure({ code: 'UPSTREAM_UNAVAILABLE' });
    }
    const feeds = parseCustomFeeds(stored?.feeds);
    const made = feeds.find(feed => feed.id === id);
    if (made) return { feed: publicFeed(made), existing: true };
    if (feeds.length >= MAX_CUSTOM_FEEDS) throw new ToolFailure({ code: 'FEED_LIMIT_REACHED', limit: MAX_CUSTOM_FEEDS });
    if (feedNameProblem(name, feeds) === 'taken') throw new ToolFailure({ code: 'FEED_NAME_TAKEN' });
    const kept: FeedIngredient[] = [];
    const notAdded = [...leftOut];
    for (const ingredient of ingredients) {
      const problem = ingredientProblem(ingredient, kept, feeds);
      if (problem) notAdded.push({ ingredient: ingredient.kind === 'keyword' ? ingredient : { kind: ingredient.kind, id: ingredient.id }, code: problem.toUpperCase().replace('-', '_') });
      else kept.push(ingredient);
    }
    if (kept.length === 0) throw new ToolFailure({ code: 'NO_FEED_INGREDIENTS', notAdded });
    let next: CustomFeed[];
    try {
      next = withFeedAdded(feeds, { name, order, ingredients: kept }, id);
    } catch (error) {
      if (!(error instanceof CustomFeedError)) throw error;
      throw new ToolFailure({ code: error.code === 'taken' ? 'FEED_NAME_TAKEN' : 'FEED_LIMIT_REACHED', ...(error.code === 'taken' ? {} : { limit: MAX_CUSTOM_FEEDS }) });
    }
    // As `changeCustomFeeds` does (src/services/custom-feeds-store.ts): only a
    // list the app reads back unaltered is written, in the document's two fields.
    const written = parseCustomFeeds(next);
    if (JSON.stringify(written) !== JSON.stringify(next)) throw new ToolFailure({ code: 'INVALID_ARGUMENTS', message: 'The feed would not be read back as written' });
    if (!await commitWrites(store, [mergeWrite(writeName(store, path), { feeds: written, updatedAt: new Date(Date.now()) }, { mustExist: false })], transaction)) return null;
    committed = true;
    return { feed: publicFeed(written.find(feed => feed.id === id)!), notAdded };
  } finally {
    if (!committed) await store.rollback(transaction).catch(() => undefined);
  }
}

async function createFeed(parsed: FeedArguments, call: AccountCall) {
  const { account } = call;
  const store = accountStore(call.env);
  const id = await writeId('feed', account.uid, parsed.requestId, 16);
  // Read before anything is spent: the same call made again, a full account
  // or a taken name asks no provider. The transaction checks all three again.
  const settings = await readStore(() => store.getDocument<{ feeds?: unknown }>(['users', account.uid, 'settings', 'customFeeds']));
  const feeds = parseCustomFeeds(settings?.feeds);
  const made = feeds.find(feed => feed.id === id);
  if (made) return { feed: publicFeed(made), existing: true };
  if (feeds.length >= MAX_CUSTOM_FEEDS) throw new ToolFailure({ code: 'FEED_LIMIT_REACHED', limit: MAX_CUSTOM_FEEDS });
  if (feedNameProblem(parsed.name, feeds) === 'taken') throw new ToolFailure({ code: 'FEED_NAME_TAKEN' });

  const release = await reserveDaily('feeds', 1, call);
  let written = false;
  try {
    const leftOut: IngredientLeftOut[] = [];
    const ingredients = parsed.from ? await paperIngredients(parsed.from, call) : await listedIngredients(parsed.ingredients, leftOut, call);
    if (ingredients.length === 0) throw new ToolFailure({ code: 'NO_FEED_INGREDIENTS', notAdded: leftOut });
    // Twice at most: a feeds document another write changed is read again.
    const result = await addFeedOnce(store, account.uid, id, parsed, ingredients, leftOut)
      ?? await addFeedOnce(store, account.uid, id, parsed, ingredients, leftOut);
    if (!result) throw new ToolFailure({ code: 'FEEDS_CHANGED' });
    written = !('existing' in result);
    return result;
  } finally {
    if (!written) await release();
  }
}

// Each tool's arguments are read once, then the call runs on what was read.
function tool<T>(parse: (args: Arguments) => T, run: (parsed: T, caller: Request, env: WorkerEnv) => Promise<Record<string, unknown>>) {
  return (args: Arguments) => {
    const parsed = parse(args);
    return (caller: Request, env: WorkerEnv) => run(parsed, caller, env);
  };
}

function accountTool<T>(scope: AgentScope, parse: (args: Arguments) => T, run: (parsed: T, call: AccountCall) => Promise<Record<string, unknown>>) {
  return { scope, forAccount: (account: Account) => tool(parse, (parsed, caller, env) => run(parsed, { account, caller, env })) };
}

const RUN: Record<ToolName, ReturnType<typeof tool>> = {
  search_papers: tool(searchArguments, searchPapers),
  get_paper: tool(getPaperArguments, getPaper),
  find_open_access: tool(openAccessArguments, findOpenAccess),
};

// Each account tool with the scope a token needs to list and call it.
const ACCOUNT_RUN: Record<AccountToolName, ReturnType<typeof accountTool>> = {
  find_similar_papers: accountTool('account:read', similarArguments, findSimilarPapers),
  get_citation_graph: accountTool('account:read', getPaperArguments, getCitationGraph),
  list_my_lists: accountTool('account:read', noArguments, listMyLists),
  get_list: accountTool('account:read', listArguments, getList),
  list_my_feeds: accountTool('account:read', noArguments, listMyFeeds),
  create_list: accountTool('lists:write', createListArguments, createList),
  add_papers_to_list: accountTool('lists:write', addPapersArguments, addPapersToList),
  create_feed: accountTool('feeds:write', createFeedArguments, createFeed),
};

// The tool `name` is for this caller: a public one, or an account tool whose
// scope the caller's token carries. Any other name is no tool of theirs.
function toolFor(name: string, agent: AgentIdentity | null) {
  if (Object.hasOwn(RUN, name)) return RUN[name as ToolName];
  if (!agent || !Object.hasOwn(ACCOUNT_RUN, name)) return null;
  const { scope, forAccount } = ACCOUNT_RUN[name as AccountToolName];
  return agent.scopes.includes(scope) ? forAccount(agent) : null;
}

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
      : /^(?:UPSTREAM_|(?:PROVIDER_QUOTA|ACCOUNT_DATA)_NOT_CONFIGURED$)/.test(code) ? 503 : 0;
  if (!status) return;
  console.warn(JSON.stringify({ route: MCP_PATH, tool, ...(details.source ? { source: details.source } : {}), code, status }));
  captureWorkerResponseFailure(status);
}

// The arguments are checked before the reservation, so a malformed call costs
// nothing; the reservation comes before any route, so a refused call asks nothing.
// A call with an agent token is counted against its account, whatever address
// it comes from, and one without against the address.
async function callTool(called: NonNullable<ReturnType<typeof toolFor>>, params: Record<string, unknown>, request: Request, env: WorkerEnv, agent: AgentIdentity | null) {
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
    const run = called(args as Arguments);
    const caller = agent
      ? await reserveAccountMinute(agent.uid, env, MCP_CALLER_MINUTE.namespace, MCP_CALLER_MINUTE.limit)
      : await reserveCallerMinute(request, env, MCP_CALLER_MINUTE.namespace, MCP_CALLER_MINUTE.limit);
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

// The account a request's agent token names, or null for a request without an
// `Authorization` header. A header that carries anything else is refused
// (`verifyAgentToken`): a presented credential is never ignored.
async function agentOf(request: Request, env: WorkerEnv) {
  const authorization = request.headers.get('authorization');
  if (authorization === null) return null;
  return verifyAgentToken(authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || '', env);
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
  let agent: AgentIdentity | null;
  try {
    agent = await agentOf(request, env);
  } catch (error) {
    if (!(error instanceof WorkerAuthError)) throw error;
    if (error.status !== 401) return rpcError(null, -32002, 'Agent tokens are not configured', error.status);
    return rpcError(null, -32001, 'Invalid or expired agent token', 401, { 'www-authenticate': 'Bearer' });
  }
  // `initialize` carries no header; a client sends it on the requests after.
  // Without sessions the server cannot tell which version a request without
  // it was negotiated under, so it serves one as a listed version instead of
  // assuming 2025-03-26, as the transport suggests, and refusing it.
  const version = request.headers.get('mcp-protocol-version');
  if (version && !PROTOCOL_VERSIONS.includes(version)) return rpcError(null, -32600, 'Unsupported MCP-Protocol-Version', 400);

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
      instructions: instructionsFor(agent),
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: agent ? [...TOOLS, ...ACCOUNT_TOOLS.filter(tool => agent.scopes.includes(ACCOUNT_RUN[tool.name].scope))] : TOOLS });
  }
  if (method === 'tools/call') {
    // An account tool this caller cannot use is answered as a name that is no tool.
    const called = params && typeof params === 'object' ? toolFor(String(params.name), agent) : null;
    if (!called) return rpcError(id, -32602, 'Unknown tool');
    try {
      return rpcResult(id, await callTool(called, params, request, env, agent));
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
