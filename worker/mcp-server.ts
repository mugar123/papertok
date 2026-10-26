import type { Paper } from '../src/models/paper.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import type { WorkerEnv } from './env.ts';

import { PaperBuilder } from '../src/services/paper-builder.ts';
import { OPENALEX_WORK_SEARCH_FIELDS, mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { getPaperIdentity } from '../src/utils/public-navigation.ts';
import { handleArxiv } from './arxiv-api.ts';
import { readBoundedJson } from './bounded-body.ts';
import { reserveCallerMinute } from './caller-quota.ts';
import { handleCitationGraph } from './citation-graph.ts';
import { allowedOrigins, json } from './http.ts';
import { handleOpenAccess } from './open-access.ts';
import { handleOpenAlex } from './openalex-api.ts';
import { arxivRecordPaper, parseArxivAtom } from './paper-sources.ts';

/**
 * PaperTok as a remote MCP server (ENG-91, phase 1): public, read-only, no
 * account. Streamable HTTP without sessions or server-sent events: every POST
 * carries one JSON-RPC message and gets one JSON answer. The official SDK is
 * not used; this handler covers the four methods phase 1 needs.
 *
 * Every tool asks an existing route in-process, as `paper-sources.ts` does
 * for the harvest, but as a reader: the route's validation, cache keys,
 * provider budgets and per-address allowances apply exactly as they do to the
 * browser. The caller's `CF-Connecting-IP` travels with each ask, so those
 * allowances count this caller.
 */
export const MCP_PATH = '/mcp';

// Newest first: an unknown version asked for in `initialize` gets the first.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
// When a client sends no `MCP-Protocol-Version`, the transport says to assume this one.
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 16 * 1024;
// Tool calls one address may make in a UTC minute, cache hits included. The
// routes behind them keep their own per-address limits on misses; this one
// also covers the citation graph, which the browser reaches only signed in.
const MCP_CALLER_MINUTE = Object.freeze({ namespace: 'mcp', limit: 30 });
const MAX_RESULTS = 10;
// One paper of a large collaboration lists thousands of authors.
const MAX_AUTHORS = 100;
const MAX_OA_LOCATIONS = 5;

const SERVER_INFO = Object.freeze({ name: 'papertok', title: 'PaperTok', version: '1.0.0' });
const INSTRUCTIONS = 'Read-only access to scholarly papers as PaperTok normalizes them. Results carry abstracts and metadata, never full text. A missing abstract, citation count or review status is unknown, not zero or false.';

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const PAPER_ID_SCHEMA = { type: 'string', description: 'A DOI (10.xxxx/...), arXiv id (2401.01234), OpenAlex work id (W123...) or PubMed id (pmid:123). URLs and doi:/arxiv: prefixes are accepted.' };
const DOI_SCHEMA = { type: 'string', description: 'The DOI, with or without https://doi.org/.' };

const TOOLS = [
  {
    name: 'search_papers',
    title: 'Search papers',
    description: `Searches OpenAlex and arXiv and merges records of the same paper by DOI or arXiv id. Returns at most ${MAX_RESULTS} papers in PaperTok's paper format, with author lists cut at ${MAX_AUTHORS} names. A source that is unavailable or over its budget is listed in "unavailable".`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 300, description: 'Search words.' },
        sources: { type: 'array', items: { type: 'string', enum: ['openalex', 'arxiv'] }, minItems: 1, uniqueItems: true, description: 'Defaults to both.' },
        since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Only papers published or submitted on or after this date (YYYY-MM-DD).' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, default: MAX_RESULTS },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_paper',
    title: 'Get a paper',
    description: 'Looks one paper up by DOI, arXiv id or OpenAlex work id and returns it in PaperTok\'s paper format (abstract and metadata, not full text).',
    inputSchema: { type: 'object', properties: { id: PAPER_ID_SCHEMA }, required: ['id'], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'find_open_access',
    title: 'Find open access',
    description: `Finds legal open-access copies of a paper by DOI (Unpaywall, then Crossref licences): whether one exists, the best location, its licence and version, and up to ${MAX_OA_LOCATIONS} locations. "is_oa": null means it is unknown.`,
    inputSchema: { type: 'object', properties: { doi: DOI_SCHEMA }, required: ['doi'], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'get_citation_graph',
    title: 'Get citation graph',
    description: 'Returns papers a DOI cites and papers citing it (OpenCitations and OpenAlex), with the total counts. "degraded": true means a provider failed and the lists may be incomplete.',
    inputSchema: {
      type: 'object',
      properties: { doi: DOI_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, default: 8, description: 'Papers per list.' } },
      required: ['doi'],
      additionalProperties: false,
    },
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
  const sources = args.sources === undefined ? ['openalex', 'arxiv'] : args.sources;
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
  return { query, sources: sources as string[], since, limit: integerArgument(args.limit, MAX_RESULTS, 'limit') };
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
  const response = await handler(new Request(url, { headers }), env);
  if (response.ok) return response;
  if (response.status === 404) throw new ToolFailure({ code: 'NOT_FOUND' });
  // The route's own validation: an identifier the relay cannot carry.
  if (response.status === 400) throw new ToolFailure({ code: 'INVALID_ARGUMENTS', message: 'PaperTok cannot look this identifier up' });
  const answer = await response.json<{ code?: string }>().catch(() => null);
  if (response.status === 429) {
    throw new ToolFailure({
      code: answer?.code || 'PROVIDER_RATE_LIMITED',
      retryAfterSeconds: Number(response.headers.get('retry-after')) || 60,
    });
  }
  throw new ToolFailure({ code: answer?.code || 'UPSTREAM_UNAVAILABLE', upstreamStatus: response.status });
}

// The provider's record is left behind, and an author list is bounded.
function publicPaper(paper: Partial<Paper>) {
  const relayed = { ...paper, authors: (paper.authors || []).slice(0, MAX_AUTHORS) };
  delete relayed.raw;
  return relayed;
}

async function searchOpenAlex(query: string, since: string, limit: number, caller: Request, env: WorkerEnv) {
  const response = await ask(handleOpenAlex, '/openalex/works', {
    search: query,
    filter: since ? `from_publication_date:${since}` : '',
    'per-page': limit,
    select: OPENALEX_WORK_SEARCH_FIELDS.join(','),
  }, caller, env);
  const { results = [] } = await response.json<{ results?: OpenAlexWork[] }>();
  return results.map(work => mapOpenAlexWork(work));
}

function arxivQuery(query: string, since: string) {
  const terms = query.split(' ')
    .map(term => term.replace(/[^\p{L}\p{N}.-]/gu, ''))
    .filter(Boolean)
    .slice(0, 12)
    .map(term => `all:${term}`);
  if (since) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    terms.push(`submittedDate:[${since.replace(/-/g, '')}0000 TO ${today}2359]`);
  }
  return terms.join(' AND ');
}

async function arxivPapers(params: Record<string, string | number>, caller: Request, env: WorkerEnv) {
  const response = await ask(handleArxiv, '/arxiv', params, caller, env);
  return parseArxivAtom(await response.text()).map(arxivRecordPaper);
}

async function searchPapers({ query, sources, since, limit }: ReturnType<typeof searchArguments>, caller: Request, env: WorkerEnv) {
  const searches: Record<string, () => Promise<Array<Partial<Paper> | null>>> = {
    openalex: () => searchOpenAlex(query, since, limit, caller, env),
    arxiv: () => arxivPapers({ search_query: arxivQuery(query, since), max_results: limit, sortBy: 'relevance' }, caller, env),
  };
  const settled = await Promise.allSettled(sources.map(source => searches[source]()));
  const unavailable = settled.flatMap((outcome, index) => outcome.status === 'rejected'
    ? [{ source: sources[index], ...(outcome.reason instanceof ToolFailure ? outcome.reason.details : { code: 'UPSTREAM_UNAVAILABLE' }) }]
    : []);
  if (unavailable.length === sources.length) throw new ToolFailure({ code: 'SOURCES_UNAVAILABLE', unavailable });
  const found = settled.flatMap(outcome => (outcome.status === 'fulfilled' ? outcome.value : []));
  const papers = PaperBuilder.deduplicate(found).slice(0, limit).map(publicPaper);
  return { query, papers, unavailable };
}

function getPaperArguments(args: Arguments) {
  onlyKeys(args, ['id']);
  const identity = paperIdentity(args.id);
  if (!identity) throw new InvalidArguments('id must be a DOI, arXiv id or OpenAlex work id');
  return identity;
}

async function getPaper(identity: ReturnType<typeof getPaperArguments>, caller: Request, env: WorkerEnv) {
  if (identity.type === 'arxiv') {
    const arxivId = identity.value.replace(/v\d+$/, '');
    const [paper] = await arxivPapers({ id_list: arxivId, max_results: 1 }, caller, env);
    if (!paper) throw new ToolFailure({ code: 'NOT_FOUND' });
    return { paper: publicPaper(paper) };
  }
  // One work by id: OpenAlex does not bill it, so it spends no budget.
  const response = await ask(handleOpenAlex, `/openalex/works/${identity.type === 'openalex' ? identity.value : `${identity.type}:${identity.value}`}`, {}, caller, env);
  const paper = mapOpenAlexWork(await response.json<OpenAlexWork>());
  if (!paper) throw new ToolFailure({ code: 'NOT_FOUND' });
  return { paper: publicPaper(paper) };
}

function openAccessArguments(args: Arguments) {
  onlyKeys(args, ['doi']);
  return { doi: doiArgument(args.doi) };
}

async function findOpenAccess({ doi }: ReturnType<typeof openAccessArguments>, caller: Request, env: WorkerEnv) {
  const response = await ask(handleOpenAccess, '/oa', { doi }, caller, env);
  const record = await response.json<Record<string, unknown> & { oa_locations?: unknown[] }>();
  return {
    doi,
    is_oa: record.is_oa ?? null,
    oa_status: record.oa_status ?? null,
    best_oa_location: record.best_oa_location ?? null,
    oa_locations: (record.oa_locations || []).slice(0, MAX_OA_LOCATIONS),
    source: record.source || 'unpaywall',
  };
}

function citationGraphArguments(args: Arguments) {
  onlyKeys(args, ['doi', 'limit']);
  return { doi: doiArgument(args.doi), limit: integerArgument(args.limit, 8, 'limit') };
}

async function getCitationGraph({ doi, limit }: ReturnType<typeof citationGraphArguments>, caller: Request, env: WorkerEnv) {
  const response = await ask(handleCitationGraph, '/citation-graph', { doi, limit }, caller, env);
  const graph = await response.json<{ references: Paper[]; citations: Paper[]; counts: unknown; source: string; partial: boolean; degraded: boolean }>();
  return {
    doi,
    references: graph.references.map(publicPaper),
    citations: graph.citations.map(publicPaper),
    counts: graph.counts,
    source: graph.source,
    partial: graph.partial,
    degraded: graph.degraded,
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
  get_citation_graph: tool(citationGraphArguments, getCitationGraph),
};

// The arguments are checked before the reservation, so a malformed call costs
// nothing; the reservation comes before any route, so a refused call asks nothing.
async function callTool(params: Record<string, unknown>, request: Request, env: WorkerEnv) {
  const args = params.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return toolResult({ code: 'INVALID_ARGUMENTS', message: 'arguments must be an object' }, true);
  }
  try {
    const run = RUN[params.name as ToolName](args as Arguments);
    const caller = await reserveCallerMinute(request, env, MCP_CALLER_MINUTE.namespace, MCP_CALLER_MINUTE.limit);
    if (caller.reading.code) return toolResult({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, true);
    if (!caller.reading.accepted) {
      return toolResult({ code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: Number(caller.retryAfter) }, true);
    }
    return toolResult(await run(request, env));
  } catch (error) {
    if (error instanceof InvalidArguments) return toolResult({ code: 'INVALID_ARGUMENTS', message: error.message }, true);
    if (error instanceof ToolFailure) return toolResult(error.details, true);
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
  // A notification, or a response to a request this server never sends.
  if (id === undefined) return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof method !== 'string') {
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
    return rpcResult(id, await callTool(params, request, env));
  }
  return rpcError(id, -32601, 'Method not found');
}
