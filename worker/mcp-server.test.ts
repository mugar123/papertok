import type { WorkerEnv } from './env.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import { mintAgentToken } from './agent-token.ts';
import { trackErrors } from './error-tracking.ts';
import type { FirestoreWrite } from './firestore-admin.ts';
import { decodeFields, encodeFields } from './firestore-admin.ts';
import reportApi from './index.ts';
import { storedClassification } from '../src/models/paper.ts';
import { WRITTEN_ARXIV_COPY, WRITTEN_FALLBACK_COPY, WRITTEN_FEED_INGREDIENTS, WRITTEN_OPENALEX_COPY, writtenFeeds, writtenList } from './test-support/mcp-written-documents.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

const SECRET = 'test-only-pdf-rate-limit-key-32-bytes';
const ARXIV_ERROR_FEED = readFileSync(new URL('./test-support/arxiv-error.xml', import.meta.url), 'utf8');

// A request from outside the Worker, an agent's included, takes only even
// seats of the arXiv beat, and an agent never waits for one. Every test starts
// at the start of an even three-second period, so arXiv's seat is free
// whatever the time of day.
const EVEN_ARXIV_PERIOD = Date.parse('2026-10-24T12:00:00.000Z');
let pinnedClock: ReturnType<typeof mock.method> | undefined;
beforeEach(() => { pinnedClock = mock.method(Date, 'now', () => EVEN_ARXIV_PERIOD); });
afterEach(() => { pinnedClock?.mock.restore(); });
const routeEnv = (extra: Partial<WorkerEnv> = {}): WorkerEnv => ({
  REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
  PDF_RATE_LIMIT_SECRET: SECRET,
  ...extra,
});

// An OpenAlex work as `/openalex/works` returns it (synthetic, trimmed).
const OPENALEX_WORK = {
  id: 'https://openalex.org/W4400000001',
  doi: 'https://doi.org/10.1234/example.2026.1',
  ids: { openalex: 'https://openalex.org/W4400000001', doi: 'https://doi.org/10.1234/example.2026.1' },
  title: 'Graphene sheets under strain',
  type: 'article',
  publication_date: '2026-03-02',
  publication_year: 2026,
  authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Pérez' }, institutions: [] }],
  abstract_inverted_index: { Strain: [0], changes: [1], graphene: [2] },
  primary_location: { landing_page_url: 'https://doi.org/10.1234/example.2026.1', source: { display_name: 'Journal of Sheets', type: 'journal' } },
  locations: [],
  open_access: { is_oa: false, oa_url: null },
  cited_by_count: 4,
  concepts: [],
  topics: [],
  primary_topic: null,
};

// arXiv's Atom answer (synthetic). The second entry is the OpenAlex work's preprint.
const arxivFeed = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entries}</feed>`;
const ARXIV_LAB_ENTRY = `
  <entry>
    <id>http://arxiv.org/abs/2603.01234v2</id>
    <published>2026-03-01T10:00:00Z</published>
    <updated>2026-03-05T10:00:00Z</updated>
    <title>Strained graphene in the lab</title>
    <summary>We bend graphene and measure it.</summary>
    <author><name>Luis Gómez</name></author>
    <arxiv:primary_category term="cond-mat.mes-hall"/>
    <category term="cond-mat.mes-hall"/>
  </entry>`;
const ARXIV_PREPRINT_ENTRY = `
  <entry>
    <id>http://arxiv.org/abs/2603.09999v1</id>
    <published>2026-03-01T10:00:00Z</published>
    <updated>2026-03-01T10:00:00Z</updated>
    <title>Graphene sheets under strain</title>
    <summary>Strain changes graphene.</summary>
    <author><name>Ana Pérez</name></author>
    <arxiv:doi>10.1234/example.2026.1</arxiv:doi>
    <arxiv:primary_category term="cond-mat.mtrl-sci"/>
    <category term="cond-mat.mtrl-sci"/>
  </entry>`;
const ARXIV_FEED = arxivFeed(ARXIV_LAB_ENTRY + ARXIV_PREPRINT_ENTRY);
// OpenAlex's record of the first entry, known by its arXiv landing page (synthetic).
const ARXIV_LANDING = { landing_page_url: 'https://arxiv.org/abs/2603.01234', source: { display_name: 'arXiv (Cornell University)', type: 'repository' } };
const OPENALEX_LAB_PREPRINT = {
  ...OPENALEX_WORK,
  id: 'https://openalex.org/W4400000123',
  doi: null,
  ids: { openalex: 'https://openalex.org/W4400000123' },
  title: 'Strained graphene in the lab',
  type: 'preprint',
  primary_location: ARXIV_LANDING,
  locations: [ARXIV_LANDING],
};

const UNPAYWALL = {
  doi: '10.1234/example.2026.1',
  is_oa: true,
  oa_status: 'green',
  title: 'Graphene sheets under strain',
  best_oa_location: {
    url: 'https://arxiv.org/pdf/2603.09999',
    url_for_pdf: 'https://arxiv.org/pdf/2603.09999',
    url_for_landing_page: 'https://arxiv.org/abs/2603.09999',
    license: 'cc-by',
    version: 'submittedVersion',
    host_type: 'repository',
  },
  oa_locations: [],
  z_authors: [{ family: 'Pérez', given: 'Ana' }],
};

type Upstream = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface RpcAnswer {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown> & {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text: string }>;
    tools?: Array<{ name: string; description: string; inputSchema: { type: string }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }>;
  };
  error?: { code: number; message: string };
}

async function withUpstream<T>(upstream: Upstream, run: (calls: string[], evict: (matches: (key: string) => boolean) => void) => Promise<T>, cacheFailure?: 'read' | 'write' | 'evict') {
  const calls: string[] = [];
  const taxonomy = new Map<string, { response: Response; expires: number }>();
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return upstream(url, init);
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async request => {
        const key = String(request instanceof Request ? request.url : request);
        const entry = taxonomy.get(key);
        if (entry && cacheFailure === 'read') throw new Error('Cache read failed');
        if (cacheFailure === 'evict' || (entry && Date.now() >= entry.expires)) taxonomy.delete(key);
        return taxonomy.get(key)?.response.clone();
      },
      put: async (request, response) => {
        const url = String(request instanceof Request ? request.url : request);
        if (!new URL(url).pathname.startsWith('/mcp/taxonomy/')) return;
        if (cacheFailure === 'write') throw new Error('Cache write failed');
        const maxAge = response.headers.get('cache-control')?.match(/\bmax-age=(\d+)/i);
        if (maxAge) taxonomy.set(url, { response: response.clone(), expires: Date.now() + Number(maxAge[1]) * 1000 });
      },
    },
  };
  try {
    return await run(calls, matches => {
      for (const key of taxonomy.keys()) if (matches(key)) taxonomy.delete(key);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

const NO_UPSTREAM: Upstream = url => { throw new Error(`unexpected upstream ${url}`); };

function post(body: unknown, { headers = {}, ip = '192.0.2.7' }: { headers?: Record<string, string>; ip?: string } = {}) {
  return new Request('https://papertok-report-api.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'cf-connecting-ip': ip,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function rpc(env: WorkerEnv, body: unknown, options?: Parameters<typeof post>[1]) {
  const response = await reportApi.fetch(post(body, options), env);
  const text = await response.text();
  return { response, answer: (text ? JSON.parse(text) : null) as RpcAnswer };
}

function callTool(env: WorkerEnv, name: string, args: unknown, id = 3) {
  return rpc(env, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

test('initialize negotiates a supported protocol version and announces read-only tools', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const { response, answer } = await rpc(routeEnv(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(answer.id, 1);
    assert.equal(answer.result?.protocolVersion, '2025-06-18');
    assert.ok((answer.result?.capabilities as { tools?: unknown }).tools);
    assert.equal((answer.result?.serverInfo as { name?: string }).name, 'papertok');
    assert.deepEqual(calls, []);
  });
});

test('initialize with an unknown version answers with one the server speaks', async () => {
  await withUpstream(NO_UPSTREAM, async () => {
    const { answer } = await rpc(routeEnv(), {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} },
    });
    assert.match(String(answer.result?.protocolVersion), /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(answer.result?.protocolVersion, '1999-01-01');
  });
});

// 2025-03-26's transport requires JSON-RPC batches, which the server refuses,
// so it never agrees to that version (outside review of PR #400).
test('initialize does not agree to 2025-03-26, and a request that names it is refused', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    for (const [asked, agreed] of [['2025-03-26', '2025-11-25'], ['2025-06-18', '2025-06-18'], ['2025-11-25', '2025-11-25']]) {
      const { answer } = await rpc(routeEnv(), {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      });
      assert.equal(answer.result?.protocolVersion, agreed, asked);
    }
    const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
    const old = await rpc(routeEnv(), ping, { headers: { 'mcp-protocol-version': '2025-03-26' } });
    assert.equal(old.response.status, 400);
    assert.equal(old.answer.error?.code, -32600);
    const oldBatch = await rpc(routeEnv(), [ping], { headers: { 'mcp-protocol-version': '2025-03-26' } });
    assert.equal(oldBatch.response.status, 400);
    const served: Array<Record<string, string>> = [{ 'mcp-protocol-version': '2025-06-18' }, { 'mcp-protocol-version': '2025-11-25' }, {}];
    for (const headers of served) {
      const { response, answer } = await rpc(routeEnv(), ping, { headers });
      assert.deepEqual([response.status, answer.result], [200, {}], JSON.stringify(headers));
    }
    assert.deepEqual(calls, []);
  });
});

test('a notification is accepted with 202 and no body', async () => {
  await withUpstream(NO_UPSTREAM, async () => {
    const response = await reportApi.fetch(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), routeEnv());
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
  });
});

test('GET offers no event stream', async () => {
  const response = await reportApi.fetch(new Request('https://papertok-report-api.example/mcp', {
    headers: { accept: 'text/event-stream' },
  }), routeEnv());
  assert.equal(response.status, 405);
});

test('a browser origin outside the allowlist is refused', async () => {
  const response = await reportApi.fetch(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, {
    headers: { origin: 'https://evil.example' },
  }), routeEnv());
  assert.equal(response.status, 403);
});

test('tools/list names the three read-only tools with input schemas', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const { answer } = await rpc(routeEnv(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = answer.result?.tools || [];
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['find_open_access', 'get_paper', 'search_papers']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    // The citation graph waits for phase 2, when callers can sign in.
    const graph = await callTool(routeEnv(), 'get_citation_graph', { doi: '10.1234/example.2026.1' });
    assert.equal(graph.answer.error?.code, -32602);
    assert.deepEqual(calls, []);
  });
});

test('malformed JSON, batches and unknown methods are JSON-RPC errors', async () => {
  await withUpstream(NO_UPSTREAM, async () => {
    const parse = await rpc(routeEnv(), '{"jsonrpc":');
    assert.equal(parse.response.status, 400);
    assert.equal(parse.answer.error?.code, -32700);

    const batch = await rpc(routeEnv(), [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    assert.equal(batch.answer.error?.code, -32600);

    const unknown = await rpc(routeEnv(), { jsonrpc: '2.0', id: 9, method: 'resources/list' });
    assert.equal(unknown.answer.id, 9);
    assert.equal(unknown.answer.error?.code, -32601);

    const tool = await callTool(routeEnv(), 'delete_everything', {});
    assert.equal(tool.answer.error?.code, -32602);
  });
});

test('an oversized body is refused before it is parsed', async () => {
  const { response, answer } = await rpc(routeEnv(), {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_papers', arguments: { query: 'x'.repeat(100_000) } },
  });
  assert.equal(response.status, 413);
  assert.equal(answer.error?.code, -32600);
});

test('search_papers merges OpenAlex and arXiv, one paper per DOI', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_WORK] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED, { headers: { 'content-type': 'application/atom+xml' } });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', limit: 5 });
    assert.equal(answer.result?.isError, undefined);
    const papers = answer.result?.structuredContent?.papers as Array<{ title: string; doi?: string; arxivId?: string; raw?: unknown }>;
    assert.equal(papers.length, 2, 'the OpenAlex work and its preprint are one paper');
    const merged = papers.find(paper => paper.doi === '10.1234/example.2026.1');
    assert.equal(merged?.arxivId, '2603.09999');
    assert.ok(papers.every(paper => paper.raw === undefined), 'the provider record is not relayed');
    assert.deepEqual(answer.result?.structuredContent?.unavailable, []);
    assert.equal(JSON.parse(answer.result?.content?.[0].text || '{}').papers.length, 2);
    const openAlexCall = new URL(calls.find(url => url.startsWith('https://api.openalex.org/'))!);
    assert.equal(openAlexCall.searchParams.get('search'), 'graphene strain');
  });
});

test('search_papers merges records that share a title and first author but no identifier, and says so', async () => {
  // The published version under its DOI, and the preprint arXiv lists without one.
  const published = {
    ...OPENALEX_WORK,
    title: 'Strained graphene in the lab',
    authorships: [{ author: { id: 'https://openalex.org/A2', display_name: 'Luis Gómez' }, institutions: [] }],
  };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [published] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const env = routeEnv();
    const { answer } = await callTool(env, 'search_papers', { query: 'strained graphene' });
    const papers = answer.result?.structuredContent?.papers as Array<{ doi?: string; arxivId?: string }>;
    assert.deepEqual(papers.map(paper => [paper.doi, paper.arxivId]), [['10.1234/example.2026.1', '2603.01234']]);
    const tools = (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).answer.result?.tools;
    assert.match(String(tools?.find(tool => tool.name === 'search_papers')?.description), /identical title with a shared first-author name/);
  });
});

test('search_papers keeps works apart that share a title and only a missing or common first-author name', async () => {
  // Synthetic OpenAlex works, each under its own DOI.
  const work = (index: number, title: string, author: string | null, citations: number) => ({
    ...OPENALEX_WORK,
    id: `https://openalex.org/W44000002${index}`,
    doi: `https://doi.org/10.1234/intro.${index}`,
    ids: {},
    title,
    authorships: [{ author: { id: `https://openalex.org/A9${index}`, display_name: author }, institutions: [] }],
    cited_by_count: citations,
  });
  const longTitle = 'Introduction to the special issue on strained graphene';
  const cases = [
    // The verifier's case: no first-author name on either, which the mapper writes as "Unknown".
    [work(1, 'Introduction', null, 0), work(2, 'Introduction', null, 222)],
    [work(3, longTitle, null, 5), work(4, longTitle, null, 17)],
    // Two people who share a surname, on a title too short to name one paper.
    [work(5, 'Introduction', 'Ana Smith', 3), work(6, 'Introduction', 'John Smith', 40)],
    // And on a long title: two people who share a surname, or a given name.
    [work(7, 'Editorial: looking back and looking forward', 'Maria Garcia', 0), work(8, 'Editorial: looking back and looking forward', 'Jose Garcia', 57)],
    [work(9, 'Introduction to the special issue', 'Wei Zhang', 222), work(10, 'Introduction to the special issue', 'Wei Li', 0)],
  ];
  for (const works of cases) {
    await withUpstream(url => {
      if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: works });
      throw new Error(`unexpected upstream ${url}`);
    }, async () => {
      const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'introduction', sources: ['openalex'] });
      const papers = answer.result?.structuredContent?.papers as Array<{ doi: string; citationCount?: number }>;
      assert.deepEqual(
        papers.map(paper => [paper.doi, paper.citationCount]).sort(),
        works.map(found => [found.doi.replace('https://doi.org/', ''), found.cited_by_count]).sort(),
        works[0].title,
      );
    });
  }
});

test('search_papers ranks the merged list, so an arXiv-only title match survives a full OpenAlex page', async () => {
  // OpenAlex's record for the Llama 2 preprint carries another title: it sends
  // ten other works, and only arXiv knows the paper (src/services/paper-search-service.ts).
  const unrelated = Array.from({ length: 10 }, (_, index) => ({
    ...OPENALEX_WORK,
    id: `https://openalex.org/W44000001${index}0`,
    doi: `https://doi.org/10.1234/other.${index}`,
    ids: {},
    title: `Another study number ${index}`,
  }));
  const llama = `
  <entry>
    <id>http://arxiv.org/abs/2307.09288v2</id>
    <published>2023-07-18T10:00:00Z</published>
    <updated>2023-07-19T10:00:00Z</updated>
    <title>Llama 2: Open Foundation and Fine-Tuned Chat Models</title>
    <summary>We release Llama 2.</summary>
    <author><name>Hugo Touvron</name></author>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/>
  </entry>`;
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: unrelated });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(llama));
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'llama 2', limit: 10 });
    const papers = answer.result?.structuredContent?.papers as Array<{ arxivId?: string }>;
    assert.equal(papers.length, 10);
    assert.equal(papers[0].arxivId, '2307.09288');
  });
});

test('a search of large collaborations stays inside what an MCP client reads', async () => {
  // About 5,800 characters, near the 6,000 `usableOpenAlexAbstract` accepts.
  const abstract = Object.fromEntries(Array.from({ length: 640 }, (_, index) => [`lorem${index}`, [index]]));
  const collaboration = (index: number) => ({
    ...OPENALEX_WORK,
    id: `https://openalex.org/W44000002${index}0`,
    doi: `https://doi.org/10.1234/collab.${index}`,
    ids: {},
    title: `Graphene collaboration ${index}`,
    abstract_inverted_index: abstract,
    authorships: Array.from({ length: 2_000 }, (_, author) => ({
      author: { id: `https://openalex.org/A${index}${author}`, display_name: `Author ${author}` },
      institutions: [{ id: `https://openalex.org/I${index}${author % 180}`, ror: `https://ror.org/${author % 180}`, display_name: `Institute ${author % 180} of Physics` }],
    })),
    concepts: Array.from({ length: 12 }, (_, concept) => ({ id: `https://openalex.org/C${concept}`, display_name: `Concept ${concept}`, level: 2, score: 0.9, wikidata: `https://www.wikidata.org/wiki/Q${concept}` })),
    topics: Array.from({ length: 8 }, (_, topic) => ({
      id: `https://openalex.org/T${topic}`,
      display_name: `Topic ${topic}`,
      score: 0.9,
      subfield: { id: 'https://openalex.org/subfields/3104', display_name: 'Condensed Matter Physics' },
      field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' },
      domain: { id: 'https://openalex.org/domains/3', display_name: 'Physical Sciences' },
    })),
  });
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000220')) return Response.json(collaboration(2));
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: Array.from({ length: 10 }, (_, index) => collaboration(index)) });
    return new Response(arxivFeed(''));
  }, async () => {
    const env = routeEnv();
    // The text block and structuredContent each carry the payload. Claude Code
    // stops reading a tool result at about 25,000 tokens, which JSON spends at
    // roughly three bytes each.
    const textBytes = (answer: RpcAnswer) => new TextEncoder().encode(answer.result?.content?.[0].text).length;
    for (const limit of [undefined, 10]) {
      const { answer } = await callTool(env, 'search_papers', { query: 'graphene', ...(limit ? { limit } : {}) });
      const result = answer.result?.structuredContent as { papers: Array<Record<string, unknown>>; omitted?: { papers: number } };
      const asked = limit ?? 5;
      assert.ok(textBytes(answer) < 40_000, `${textBytes(answer)} bytes for a search of ${asked}`);
      assert.ok(result.papers.length >= 1);
      assert.equal(result.papers.length + (result.omitted?.papers ?? 0), asked, 'the papers left out are counted');
      for (const paper of result.papers) {
        assert.equal(paper.summary, undefined, 'the abstract is not sent twice');
        assert.equal(paper.raw, undefined);
        assert.ok(String(paper.abstract).length <= 1_501);
        assert.match(String(paper.abstract), /…$/);
        assert.ok(Number((paper.omitted as Record<string, number>).abstract) > 4_000);
      }
    }
    // One paper asked for alone keeps its whole abstract.
    const { answer } = await callTool(env, 'get_paper', { id: 'W4400000220' });
    const paper = answer.result?.structuredContent?.paper as { abstract: string; omitted?: Record<string, number> };
    assert.ok(paper.abstract.length > 5_000);
    assert.equal(paper.omitted?.abstract, undefined);
  });
});

test('search_papers asks the same upstream questions whatever the limit', async () => {
  const upstream: Upstream = url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_WORK] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED);
    throw new Error(`unexpected upstream ${url}`);
  };
  // Separate environments, so the second search does not wait for arXiv's beat.
  const search = (limit: number) => withUpstream(upstream, async calls => {
    const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', limit });
    return { papers: answer.result?.structuredContent?.papers as unknown[], asked: [...calls].sort() };
  });
  const one = await search(1);
  const seven = await search(7);
  assert.equal(one.papers.length, 1);
  assert.equal(seven.papers.length, 2);
  assert.equal(one.asked.length, 2);
  assert.deepEqual(seven.asked, one.asked);
});

test('search_papers accepts empty result lists from both providers', async () => {
  await withUpstream(url => url.startsWith('https://api.openalex.org/')
    ? Response.json({ results: [] }) : new Response(arxivFeed('<![CDATA[  ]]>')), async calls => {
    const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'graphene' });
    assert.equal(answer.result?.isError, undefined);
    assert.deepEqual(answer.result?.structuredContent?.papers, []);
    assert.deepEqual(answer.result?.structuredContent?.unavailable, []);
    assert.equal(calls.length, 2);
  });
});

for (const [source, body] of [
  ['openalex', '{}'],
  ['openalex', '{"results":{}}'],
  ['openalex', '{'],
  ['arxiv', '<feed><entry></feed>'],
  ['arxiv', '<feedback/>'],
  ['arxiv', '<feed/><other/>'],
  ['arxiv', '<feed/><feed/>'],
  ['arxiv', '<feed/>unexpected'],
  ['arxiv', '<feed>temporarily unavailable</feed>'],
  ['arxiv', '<feed xml:lang="en">temporarily unavailable</feed>'],
]) {
  test(`search_papers reports an invalid ${source} response (${body})`, async () => {
    await withUpstream(() => new Response(body), async calls => {
      const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'graphene', sources: [source] });
      assert.equal(answer.result?.isError, true);
      assert.equal(answer.result?.structuredContent?.code, 'SOURCES_UNAVAILABLE');
      assert.deepEqual(answer.result?.structuredContent?.unavailable, [{ source, code: 'UPSTREAM_UNAVAILABLE' }]);
      assert.equal(calls.length, 1);
    });
  });
}

test('an Atom error entry makes arXiv unavailable for search and lookup', async () => {
  await withUpstream(url => url.startsWith('https://api.openalex.org/')
    ? Response.json({ results: [OPENALEX_WORK] }) : new Response(ARXIV_ERROR_FEED), async calls => {
    const search = await callTool(routeEnv(), 'search_papers', { query: 'graphene', sources: ['arxiv'] });
    const unavailable = [{ source: 'arxiv', code: 'UPSTREAM_UNAVAILABLE' }];
    assert.equal(search.answer.result?.isError, true);
    assert.equal(search.answer.result?.structuredContent?.code, 'SOURCES_UNAVAILABLE');
    assert.deepEqual(search.answer.result?.structuredContent?.unavailable, unavailable);

    const both = await callTool(routeEnv(), 'search_papers', { query: 'graphene' });
    assert.equal(both.answer.result?.isError, undefined);
    const papers = both.answer.result?.structuredContent?.papers as Array<{ id: string }>;
    assert.deepEqual(papers.map(paper => paper.id), ['openalex:W4400000001']);
    assert.deepEqual(both.answer.result?.structuredContent?.unavailable, unavailable);

    const lookup = await callTool(routeEnv(), 'get_paper', { id: 'arxiv:2603.01234' });
    assert.equal(lookup.answer.result?.isError, true);
    assert.equal(lookup.answer.result?.structuredContent?.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(calls.length, 4);
  });
});

test('get_paper reports an unreadable arXiv feed without another lookup', async () => {
  await withUpstream(() => new Response('<feedback/>'), async calls => {
    const { answer } = await callTool(routeEnv(), 'get_paper', { id: 'arxiv:2603.01234' });
    assert.equal(answer.result?.isError, true);
    assert.equal(answer.result?.structuredContent?.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(calls.length, 1);
  });
});

test('search_papers keeps OpenAlex papers when arXiv sends a truncated feed', async () => {
  await withUpstream(url => url.startsWith('https://api.openalex.org/')
    ? Response.json({ results: [OPENALEX_WORK] }) : new Response('<feed>'), async calls => {
    const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'graphene' });
    assert.equal(answer.result?.isError, undefined);
    const papers = answer.result?.structuredContent?.papers as Array<{ id: string }>;
    assert.deepEqual(papers.map(paper => paper.id), ['openalex:W4400000001']);
    assert.deepEqual(answer.result?.structuredContent?.unavailable, [{ source: 'arxiv', code: 'UPSTREAM_UNAVAILABLE' }]);
    assert.equal(calls.length, 2);
  });
});

test('search_papers keeps arXiv when the OpenAlex budget refuses the search', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    // A minute ceiling smaller than one search: the relay must refuse before calling.
    const { answer } = await callTool(routeEnv({ OPENALEX_GLOBAL_MINUTE_LIMIT: '1' }), 'search_papers', { query: 'graphene' });
    assert.equal(answer.result?.isError, undefined);
    assert.equal(calls.some(url => url.startsWith('https://api.openalex.org/')), false);
    const unavailable = answer.result?.structuredContent?.unavailable as Array<{ source: string; code: string }>;
    assert.deepEqual(unavailable.map(item => [item.source, item.code]), [['openalex', 'PROVIDER_RATE_LIMITED']]);
    assert.equal((answer.result?.structuredContent?.papers as unknown[]).length, 2);
  });
});

test('get_paper looks a DOI up as one OpenAlex work and returns the normalized paper', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/doi:10.1234/example.2026.1')) return Response.json(OPENALEX_WORK);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const { answer } = await callTool(routeEnv(), 'get_paper', { id: 'https://doi.org/10.1234/EXAMPLE.2026.1' });
    const paper = answer.result?.structuredContent?.paper as { title: string; doi: string; citationCountKnown: boolean; raw?: unknown };
    assert.equal(paper.title, 'Graphene sheets under strain');
    assert.equal(paper.doi, '10.1234/example.2026.1');
    assert.equal(paper.citationCountKnown, true);
    assert.equal(paper.raw, undefined);
    assert.equal(calls.length, 1);
  });
});

test('get_paper builds the paper as the paper page does, with citationCount and journal and no invented venue', async () => {
  const noVenue = { ...OPENALEX_WORK, id: 'https://openalex.org/W4400000009', doi: null, ids: {}, primary_location: null };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000001')) return Response.json(OPENALEX_WORK);
    if (url.startsWith('https://api.openalex.org/works/W4400000009')) return Response.json(noVenue);
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const env = routeEnv();
    const known = await callTool(env, 'get_paper', { id: 'W4400000001' });
    const paper = known.answer.result?.structuredContent?.paper as { citationCount: number; citationCountKnown: boolean; journal: string; citationsCount?: number };
    assert.equal(paper.citationCount, 4);
    assert.equal(paper.citationCountKnown, true);
    assert.equal(paper.journal, 'Journal of Sheets');

    const missing = await callTool(env, 'get_paper', { id: 'W4400000009' });
    assert.equal(missing.answer.result?.isError, undefined);
    assert.doesNotMatch(JSON.stringify(missing.answer.result?.structuredContent), /Unknown Journal/);
  });
});

test('a field the source did not give stays absent, in a search and in get_paper', async () => {
  // OpenAlex knows nothing of this work's abstract, access, citations, venue or
  // subjects, nor the names of two of its authors: one it knows by id, one not at all.
  const bare = {
    id: 'https://openalex.org/W4400000077',
    doi: null,
    ids: {},
    title: 'Graphene sheets without a record',
    type: 'article',
    publication_date: '2026-03-02',
    publication_year: 2026,
    authorships: [
      { author: { id: 'https://openalex.org/A1', display_name: 'Ana Pérez' }, institutions: [] },
      { author: { id: 'https://openalex.org/A2', display_name: null }, institutions: [] },
      { author: {}, institutions: [] },
    ],
    abstract_inverted_index: null,
    primary_location: null,
    locations: [],
    open_access: null,
    concepts: [],
    topics: [],
    primary_topic: null,
  };
  const unknown = ['abstract', 'openAccess', 'citationCount', 'referenceCount', 'hasReferences', 'hasData', 'hasSupplement',
    'concepts', 'topics', 'institutions', 'biomedicalTerms', 'projectIds', 'researchResources', 'categories', 'keywords',
    'primaryCategory', 'primaryTopic', 'sourceType', 'provider', 'sourceName', 'journal', 'publisher'];
  // A work OpenAlex lists without authorships.
  const anonymous = { ...bare, id: 'https://openalex.org/W4400000078', authorships: undefined };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000077')) return Response.json(bare);
    if (url.startsWith('https://api.openalex.org/works/W4400000078')) return Response.json(anonymous);
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [bare] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'graphene sheets' });
    const papers = searched.answer.result?.structuredContent?.papers as Array<Record<string, unknown>>;
    const work = papers.find(paper => paper.title === 'Graphene sheets without a record')!;
    const preprint = papers.find(paper => paper.arxivId === '2603.01234')!;
    const looked = await callTool(env, 'get_paper', { id: 'W4400000077' });
    const paper = looked.answer.result?.structuredContent?.paper as Record<string, unknown>;
    for (const [name, relayed] of [['search', work], ['get_paper', paper]] as const) {
      assert.deepEqual(unknown.filter(key => key in relayed), [], `${name} relays only what OpenAlex gave`);
      assert.equal(relayed.citationCountKnown, false);
      const authors = relayed.authors as Array<{ name?: string; id?: string }>;
      assert.deepEqual(authors.map(author => [author.name, author.id]), [
        ['Ana Pérez', 'https://openalex.org/A1'],
        [undefined, 'https://openalex.org/A2'],
      ], `${name} keeps what OpenAlex gave of each author`);
    }
    // Ana Pérez has a name but no institution, and an arXiv author no id.
    for (const [name, relayed] of [['search', work], ['get_paper', paper], ['arXiv', preprint]] as const) {
      const empty = (relayed.authors as Array<Record<string, unknown>>)
        .flatMap(author => Object.entries(author).filter(([, value]) => value === null || value === '').map(([key]) => key));
      assert.deepEqual(empty, [], `${name} sends no author field the source did not give`);
    }
    const unlisted = await callTool(env, 'get_paper', { id: 'W4400000078' });
    assert.equal('authors' in (unlisted.answer.result?.structuredContent?.paper as Record<string, unknown>), false, 'no author is invented');
    // arXiv gives no citations, institutions or subjects, and a preprint record
    // says nothing of the review of a later version.
    assert.deepEqual(['citationCount', 'peerReviewed', 'institutions', 'concepts', 'topics', 'referenceCount'].filter(key => key in preprint), []);
    assert.equal(preprint.publicationStatus, 'preprint');
    assert.equal(preprint.openAccess, true);
  });
});

test("an arXiv record's DOI alone does not make its paper peer reviewed, nor a repository's DOI published, in a search and in get_paper", async () => {
  // arXiv lists a DOI and nothing else: no journal reference, no comment.
  const listing = (doi: string) => ARXIV_LAB_ENTRY.replace('<author>', `<arxiv:doi>${doi}</arxiv:doi><author>`);
  const inJournal = ARXIV_LAB_ENTRY
    .replace('2603.01234', '2603.04321')
    .replace('<author>', '<arxiv:doi>10.1234/sheets.2026.7</arxiv:doi><arxiv:journal_ref>Journal of Sheets 12, 34 (2026)</arxiv:journal_ref><author>');
  // arXiv's own DOI, a Zenodo deposit's and a bioRxiv preprint's are a
  // repository's; the last is a publisher's.
  for (const [doi, status] of [
    ['10.48550/arXiv.2603.01234', 'preprint'], ['10.5281/zenodo.99999', 'preprint'], ['10.1101/2023.05.01.538912', 'preprint'],
    ['10.1234/sheets.2026.1', 'published'],
    ['10.48550/arXiv.2603.01234 10.1234/sheets.2026.1', 'published'],
    ['10.1234/sheets.2026.1 10.48550/arXiv.2603.01234', 'published'],
  ]) {
    await withUpstream(url => {
      if (url.includes('id_list=2603.04321')) return new Response(arxivFeed(inJournal));
      if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(listing(doi)));
      throw new Error(`unexpected upstream ${url}`);
    }, async () => {
      // Separate environments, so each arXiv request finds the beat's seat free.
      const searched = await callTool(routeEnv(), 'search_papers', { query: 'strained graphene', sources: ['arxiv'] });
      const [listed] = searched.answer.result?.structuredContent?.papers as Array<Record<string, unknown>>;
      const looked = await callTool(routeEnv(), 'get_paper', { id: '2603.01234' });
      const paper = looked.answer.result?.structuredContent?.paper as Record<string, unknown>;
      for (const [name, relayed] of [['search', listed], ['get_paper', paper]] as const) {
        assert.equal(relayed.doi, doi, `${name} keeps ${doi}`);
        assert.equal(relayed.publicationStatus, status, `${name} ${doi}`);
        assert.equal('peerReviewed' in relayed, false, `${name} ${doi}`);
      }
      // A journal reference is evidence of its own.
      const published = await callTool(routeEnv(), 'get_paper', { id: '2603.04321' });
      assert.equal((published.answer.result?.structuredContent?.paper as { peerReviewed?: boolean }).peerReviewed, true);
    });
  }
});

test('a repository preprint is given no journal venue and no feed adapter label, in a search and in get_paper', async () => {
  // A working paper on SSRN as OpenAlex lists it (synthetic).
  const ssrn = {
    ...OPENALEX_WORK,
    id: 'https://openalex.org/W4400000088',
    doi: 'https://doi.org/10.2139/ssrn.4400088',
    ids: {},
    title: 'Graphene prices in a working paper',
    type: 'preprint',
    primary_location: {
      landing_page_url: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4400088',
      is_published: false,
      source: { display_name: 'SSRN Electronic Journal', type: 'repository', host_organization_name: 'Elsevier BV' },
    },
  };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000088')) return Response.json(ssrn);
    if (url.startsWith('https://api.openalex.org/works?filter=locations')) return Response.json({ results: [OPENALEX_LAB_PREPRINT] });
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [ssrn] });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'graphene prices', sources: ['openalex'] });
    const [listed] = searched.answer.result?.structuredContent?.papers as Array<Record<string, unknown>>;
    const looked = await callTool(env, 'get_paper', { id: 'W4400000088' });
    const paper = looked.answer.result?.structuredContent?.paper as Record<string, unknown>;
    // In an odd period arXiv's seat is not a tool's, so get_paper answers an
    // arXiv id with OpenAlex's record, whose source is arXiv's repository.
    const clock = mock.method(Date, 'now', () => EVEN_ARXIV_PERIOD + 3_000);
    const fallback = await callTool(env, 'get_paper', { id: '2603.01234' }).finally(() => clock.mock.restore());
    const fromOpenAlex = fallback.answer.result?.structuredContent?.paper as Record<string, unknown>;
    assert.equal(fromOpenAlex.id, 'openalex:W4400000123');    assert.equal(calls.some(url => url.startsWith('https://export.arxiv.org/')), false);
    for (const [name, relayed] of [['search', listed], ['get_paper', paper], ['arXiv fallback', fromOpenAlex]] as const) {
      assert.equal(relayed.publicationType, 'preprint', name);
      assert.deepEqual(['sourceType', 'provider', 'journal', 'publisher'].filter(key => key in relayed), [], name);
    }
  });
});

test('get_paper asks arXiv for an arXiv id and reports an unknown id as not found', async () => {
  await withUpstream(url => {
    if (url.includes('id_list=2603.01234')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
    if (url.startsWith('https://api.openalex.org/works/W1')) return Response.json({ error: 'Not found' }, { status: 404 });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const env = routeEnv();
    const found = await callTool(env, 'get_paper', { id: 'arXiv:2603.01234v2' });
    const paper = found.answer.result?.structuredContent?.paper as { arxivId: string; title: string };
    assert.equal(paper.arxivId, '2603.01234');
    assert.equal(paper.title, 'Strained graphene in the lab');

    const missing = await callTool(env, 'get_paper', { id: 'W1' });
    assert.equal(missing.answer.result?.isError, true);
    assert.equal(missing.answer.result?.structuredContent?.code, 'NOT_FOUND');
  });
});

// The `/mcp` lines a run wrote, read off a stubbed `console.warn`.
async function mcpLines(run: () => Promise<void>) {
  const warn = mock.method(console, 'warn', () => {});
  try {
    await run();
    return warn.mock.calls.map(call => String(call.arguments[0]))
      .filter(line => line.startsWith('{"route":"/mcp"'))
      .map(line => JSON.parse(line) as Record<string, unknown>);
  } finally {
    warn.mock.restore();
  }
}

test("get_paper opens an arXiv result through OpenAlex when the search has just taken arXiv's seat, as the paper page does", async () => {
  let calls: string[] = [];
  const lines = await mcpLines(() => withUpstream(url => {
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
    if (url.startsWith('https://api.openalex.org/works?') && url.includes('search=')) return Response.json({ results: [] });
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_LAB_PREPRINT] });
    throw new Error(`unexpected upstream ${url}`);
  }, async asked => {
    calls = asked;
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'strained graphene' });
    const [listed] = searched.answer.result?.structuredContent?.papers as Array<{ id: string; arxivId?: string }>;
    assert.equal(listed.arxivId, '2603.01234', 'only arXiv found it');
    const { answer } = await callTool(env, 'get_paper', { id: listed.id });
    assert.equal(answer.result?.isError, undefined);
    const paper = answer.result?.structuredContent?.paper as { id: string; arxivId: string; title: string };
    assert.deepEqual(answer.result?.structuredContent?.fallback, { from: 'arxiv', to: 'openalex', code: 'PROVIDER_RATE_LIMITED' });
    assert.deepEqual((paper as Record<string, unknown>).categories, ['cond-mat.mes-hall']);
    assert.deepEqual([paper.id, paper.arxivId, paper.title], ['openalex:W4400000123', '2603.01234', 'Strained graphene in the lab']);
  }));
  assert.equal(calls.filter(url => url.startsWith('https://export.arxiv.org/')).length, 1, 'arXiv is asked once, by the search');
  const fallback = new URL(calls.at(-1)!);
  assert.equal(fallback.searchParams.get('filter'), 'locations.landing_page_url:http://arxiv.org/abs/2603.01234|https://arxiv.org/abs/2603.01234');
  assert.deepEqual(lines, [{ route: '/mcp', tool: 'get_paper', source: 'arxiv', code: 'PROVIDER_RATE_LIMITED', status: 429 }]);
});

test("get_paper falls back to OpenAlex whenever arXiv fails, and keeps arXiv's answer when OpenAlex has not the paper", async () => {
  // An OpenAlex work of another preprint.
  const elsewhere = { landing_page_url: 'https://arxiv.org/abs/2603.07777', source: ARXIV_LANDING.source };
  const otherPreprint = { ...OPENALEX_LAB_PREPRINT, id: 'https://openalex.org/W4400000124', primary_location: elsewhere, locations: [elsewhere] };
  const filtered = (url: string, id: string) => url.startsWith('https://api.openalex.org/works?') && url.includes(id);
  let calls: string[] = [];
  const lines = await mcpLines(() => withUpstream(url => {
    // arXiv's own rate limit, then its outage, then an id it does not know.
    if (url.includes('id_list=2603.01234')) return new Response('Rate exceeded.', { status: 429, headers: { 'retry-after': '30' } });
    if (url.includes('id_list=2603.04321') || url.includes('id_list=2603.06666')) return new Response('down', { status: 503 });
    if (url.includes('id_list=2603.05555')) return new Response(arxivFeed(''));
    if (filtered(url, '2603.01234')) return Response.json({ results: [{ ...OPENALEX_LAB_PREPRINT, primary_location: null, locations: [], doi: '10.48550/arXiv.2603.01234' }] });
    if (filtered(url, '2603.04321')) return Response.json({ results: [otherPreprint] });
    if (filtered(url, '2603.06666')) return Response.json({ error: 'Service unavailable' }, { status: 503 });
    throw new Error(`unexpected upstream ${url}`);
  }, async asked => {
    calls = asked;
    // Separate environments, so each arXiv request finds the beat's seat free.
    const limited = await callTool(routeEnv(), 'get_paper', { id: '2603.01234' });
    assert.equal((limited.answer.result?.structuredContent?.paper as { id?: string })?.id, 'openalex:W4400000123');

    const another = await callTool(routeEnv(), 'get_paper', { id: '2603.04321' });
    assert.equal(another.answer.result?.isError, true, 'a work of another arXiv id is not the paper');
    assert.deepEqual(another.answer.result?.structuredContent, { code: 'UPSTREAM_UNAVAILABLE', upstreamStatus: 503 });

    const bothDown = await callTool(routeEnv(), 'get_paper', { id: '2603.06666' });
    assert.deepEqual(bothDown.answer.result?.structuredContent, { code: 'UPSTREAM_UNAVAILABLE', upstreamStatus: 503 });

    const unknown = await callTool(routeEnv(), 'get_paper', { id: '2603.05555' });
    assert.equal(unknown.answer.result?.structuredContent?.code, 'NOT_FOUND');
  }));
  assert.equal(calls.some(url => filtered(url, '2603.05555')), false, "arXiv's word that it has no such paper stands");
  assert.deepEqual(lines.map(line => [line.source, line.code, line.status]), [
    ['arxiv', 'UPSTREAM_RATE_LIMITED', 429],
    [undefined, 'UPSTREAM_UNAVAILABLE', 503],
    ['openalex', 'UPSTREAM_UNAVAILABLE', 503],
    [undefined, 'UPSTREAM_UNAVAILABLE', 503],
  ]);
});

test('get_paper keeps a hundred authors, and a cut list says how many entries it left out', async () => {
  // Every author from an institution of their own.
  const authored = (id: string, count: number) => ({
    ...OPENALEX_WORK,
    id: `https://openalex.org/${id}`,
    doi: null,
    ids: {},
    authorships: Array.from({ length: count }, (_, index) => ({
      author: { id: `https://openalex.org/A${index}`, display_name: `Author ${index}` },
      institutions: [{ id: `https://openalex.org/I${index}`, ror: `https://ror.org/0${index}`, display_name: `Institute ${index}` }],
    })),
  });
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000045')) return Response.json(authored('W4400000045', 45));
    if (url.startsWith('https://api.openalex.org/works/W4400002000')) return Response.json(authored('W4400002000', 2_000));
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [authored('W4400000045', 45)] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(''));
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    type Relayed = { authors: Array<{ name: string }>; institutions: unknown[]; omitted?: Record<string, number> };
    const env = routeEnv();
    const one = await callTool(env, 'get_paper', { id: 'W4400000045' });
    const paper = one.answer.result?.structuredContent?.paper as Relayed;
    assert.equal(paper.authors.length, 45, 'one paper keeps every one of its 45 authors');
    assert.equal(paper.authors.at(-1)?.name, 'Author 44');
    assert.equal(paper.institutions.length, 10);
    assert.deepEqual(paper.omitted, { institutions: 35 });

    const large = await callTool(env, 'get_paper', { id: 'W4400002000' });
    const collaboration = large.answer.result?.structuredContent?.paper as Relayed;
    assert.equal(collaboration.authors.length, 100);
    assert.deepEqual(collaboration.omitted, { authors: 1_900, institutions: 1_990 });
    const bytes = new TextEncoder().encode(large.answer.result?.content?.[0].text).length;
    assert.ok(bytes < 40_000, `${bytes} bytes for one paper of 2,000 authors`);

    const searched = await callTool(env, 'search_papers', { query: 'graphene' });
    const [listed] = searched.answer.result?.structuredContent?.papers as Relayed[];
    assert.equal(listed.authors.length, 20);
    assert.deepEqual(listed.omitted, { authors: 25, institutions: 35 });
  });
});

test('category and concept names are cut with the concepts, and the cut is counted', async () => {
  const conceptual = {
    ...OPENALEX_WORK,
    id: 'https://openalex.org/W4400000040',
    doi: null,
    ids: {},
    concepts: Array.from({ length: 40 }, (_, index) => ({ id: `https://openalex.org/C${index}`, display_name: `Concept ${index}`, level: 2, score: 0.9 })),
  };
  const crossListed = ARXIV_LAB_ENTRY.replace('<category term="cond-mat.mes-hall"/>', ['cond-mat.mes-hall', 'cond-mat.mtrl-sci', 'cond-mat.soft', 'cond-mat.stat-mech', 'physics.app-ph', 'physics.comp-ph', 'quant-ph']
    .map(term => `<category term="${term}"/>`).join(''));
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000040')) return Response.json(conceptual);
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [conceptual] });
    if (url.includes('id_list=2603.01234')) return new Response(arxivFeed(crossListed));
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    type Relayed = Record<string, unknown> & { concepts?: unknown[]; categories?: string[]; omitted?: Record<string, number> };
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'graphene sheets', sources: ['openalex'] });
    const [listed] = searched.answer.result?.structuredContent?.papers as Relayed[];
    const looked = await callTool(env, 'get_paper', { id: 'W4400000040' });
    const work = looked.answer.result?.structuredContent?.paper as Relayed;
    for (const [name, relayed] of [['search', listed], ['get_paper', work]] as const) {
      assert.equal(relayed.concepts?.length, 5, name);
      assert.deepEqual(relayed.categories, ['Concept 0', 'Concept 1', 'Concept 2', 'Concept 3', 'Concept 4'], name);
      assert.equal(relayed.omitted?.categories, 35, name);
      for (const key of ['keywords', 'allCategories']) {
        assert.ok(!(key in relayed) || (relayed[key] as unknown[]).length <= 5, `${name} ${key}`);
      }
    }
    const preprint = await callTool(env, 'get_paper', { id: '2603.01234' });
    const listedOnArxiv = preprint.answer.result?.structuredContent?.paper as Relayed;
    assert.deepEqual(listedOnArxiv.categories, ['cond-mat.mes-hall', 'cond-mat.mtrl-sci', 'cond-mat.soft', 'cond-mat.stat-mech', 'physics.app-ph']);
    assert.deepEqual(listedOnArxiv.omitted, { categories: 2 });
    assert.equal(listedOnArxiv.primaryCategory, 'cond-mat.mes-hall');
    for (const key of ['keywords', 'allCategories']) {
      assert.ok(!(key in listedOnArxiv) || (listedOnArxiv[key] as unknown[]).length <= 5, `arXiv ${key}`);
    }
  });
});

test('get_paper asks OpenAlex for the DOI it was given, whatever characters the DOI carries', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/doi:10.1234/odd%3Fpart%23two')) return Response.json(OPENALEX_WORK);
    // A DOI the relay cannot carry as a path goes as a one-work list.
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [] });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const env = routeEnv();
    const odd = await callTool(env, 'get_paper', { id: '10.1234/odd?part#two' });
    assert.equal((odd.answer.result?.structuredContent?.paper as { title?: string })?.title, 'Graphene sheets under strain');

    // Dot segments would make the URL parser ask for another work.
    const dotted = await callTool(env, 'get_paper', { id: '10.1234/../../works/W4400000001' });
    assert.equal(dotted.answer.result?.structuredContent?.code, 'NOT_FOUND');
    const listed = new URL(calls.at(-1)!);
    assert.equal(listed.pathname, '/works');
    assert.equal(listed.searchParams.get('filter'), 'doi:10.1234/../../works/w4400000001');
  });
});

test('a DOI given as a link is decoded once, and a DOI given as itself is read as written, in get_paper and find_open_access', async () => {
  const literal = { ...OPENALEX_WORK, id: 'https://openalex.org/W4400000025', title: 'A DOI with a percent sign' };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/doi:10.1234/odd%3Fpart?')) return Response.json(OPENALEX_WORK);
    // The DOI 10.1234/a%25b, whose own characters include `%25`.
    if (url.startsWith('https://api.openalex.org/works/doi:10.1234/a%2525b?')) return Response.json(literal);
    if (url.startsWith('https://api.unpaywall.org/v2/10.1234%2Fodd%3Fpart?')) return Response.json(UNPAYWALL);
    if (url.startsWith('https://api.openalex.org/') || url.startsWith('https://api.unpaywall.org/') || url.startsWith('https://api.crossref.org/')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const env = routeEnv();
    const title = async (id: string) => {
      const { answer } = await callTool(env, 'get_paper', { id });
      return (answer.result?.structuredContent?.paper as { title?: string } | undefined)?.title ?? answer.result?.structuredContent?.code;
    };
    for (const id of ['10.1234/odd?part', 'https://doi.org/10.1234/odd%3Fpart', 'doi.org/10.1234/odd%3fpart', 'http://dx.doi.org/10.1234%2Fodd%3Fpart']) {
      assert.equal(await title(id), 'Graphene sheets under strain', id);
    }
    for (const id of ['10.1234/a%25b', 'https://doi.org/10.1234/a%2525b']) {
      assert.equal(await title(id), 'A DOI with a percent sign', id);
    }
    // Decoded once only: this link names 10.1234/a%b, another DOI.
    assert.equal(await title('https://doi.org/10.1234/a%25b'), 'NOT_FOUND');

    const { answer } = await callTool(env, 'find_open_access', { doi: 'https://doi.org/10.1234/odd%3Fpart' });
    assert.deepEqual([answer.result?.structuredContent?.doi, answer.result?.structuredContent?.is_oa], ['10.1234/odd?part', true]);
  });
});

test('a provider failure is a tool error the client can read', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.unpaywall.org/')) return new Response('down', { status: 500 });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { response, answer } = await callTool(routeEnv(), 'find_open_access', { doi: '10.1234/example.2026.1' });
    assert.equal(response.status, 200);
    assert.equal(answer.result?.isError, true);
    assert.equal(answer.result?.structuredContent?.code, 'UPSTREAM_UNAVAILABLE');
  });
});

test("a provider's retry-after reaches every tool as seconds, whether it was given in seconds or as an HTTP date", async () => {
  // Five minutes ahead of the pinned clock (Saturday 24 October 2026, 12:00
  // GMT), as seconds and as each of the three HTTP-date forms RFC 9110 allows.
  const fiveMinutes = [String(5 * 60), new Date(EVEN_ARXIV_PERIOD + 5 * 60_000).toUTCString(), 'Saturday, 24-Oct-26 12:05:00 GMT', 'Sat Oct 24 12:05:00 2026'];
  // Neither seconds nor an HTTP date, though `Date.parse` reads each as a date.
  const malformed = ['soon', '1.5', '-5', '2026-10-24T12:05:00Z'];
  for (const header of [...fiveMinutes, new Date(EVEN_ARXIV_PERIOD - 60_000).toUTCString(), ...malformed]) {
    const refused = () => new Response('Too many requests', { status: 429, headers: { 'retry-after': header } });
    await mcpLines(() => withUpstream(url => {
      if (url.startsWith('https://api.unpaywall.org/') || url.startsWith('https://api.openalex.org/') || url.startsWith('https://export.arxiv.org/')) return refused();
      throw new Error(`unexpected upstream ${url}`);
    }, async () => {
      const expected = fiveMinutes.includes(header) ? 300 : malformed.includes(header) ? 60 : 1;
      // A route that throws the provider's refusal, and one that relays it.
      const access = await callTool(routeEnv(), 'find_open_access', { doi: '10.1234/example.2026.1' });
      const work = await callTool(routeEnv(), 'get_paper', { id: 'W4400000001' });
      const arxiv = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['arxiv'] });
      const both = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain' });
      for (const [name, { answer }] of [['find_open_access', access], ['get_paper', work], ['search arXiv', arxiv], ['search both', both]] as const) {
        assert.equal(answer.result?.structuredContent?.retryAfterSeconds, expected, `${name}, retry-after: ${header}`);
      }
      const unavailable = both.answer.result?.structuredContent?.unavailable as Array<{ source: string; retryAfterSeconds: number }>;
      assert.deepEqual(unavailable.map(entry => [entry.source, entry.retryAfterSeconds]), [['openalex', expected], ['arxiv', expected]]);
    }));
  }
});

test('find_open_access relays the legal copy and licence without the record around it', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.unpaywall.org/v2/10.1234%2Fexample.2026.1')) return Response.json(UNPAYWALL);
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callTool(routeEnv(), 'find_open_access', { doi: 'doi:10.1234/example.2026.1' });
    const result = answer.result?.structuredContent as { is_oa: boolean; best_oa_location: { license: string; url_for_pdf: string }; z_authors?: unknown };
    assert.equal(result.is_oa, true);
    assert.equal(result.best_oa_location.license, 'cc-by');
    assert.equal(result.best_oa_location.url_for_pdf, 'https://arxiv.org/pdf/2603.09999');
    assert.equal(result.z_authors, undefined);
  });
});

test('find_open_access says how many locations it left out', async () => {
  const locations = Array.from({ length: 8 }, (_, index) => ({ ...UNPAYWALL.best_oa_location, url: `https://repository${index}.example/paper` }));
  await withUpstream(url => {
    if (url.startsWith('https://api.unpaywall.org/v2/')) return Response.json({ ...UNPAYWALL, oa_locations: locations });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callTool(routeEnv(), 'find_open_access', { doi: '10.1234/example.2026.1' });
    const result = answer.result?.structuredContent as { oa_locations: Array<{ url: string }>; omitted?: Record<string, number> };
    assert.deepEqual(result.oa_locations.map(location => location.url), locations.slice(0, 5).map(location => location.url));
    assert.deepEqual(result.omitted, { oa_locations: 3 });
  });
});

test('invalid arguments are a tool error and reach no provider', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const env = routeEnv();
    for (const [name, args] of [
      ['search_papers', { query: ' ' }],
      ['search_papers', { query: 'graphene', sources: ['pubmed'] }],
      ['search_papers', { query: 'graphene', since: '2026-13-40' }],
      ['search_papers', { query: 'graphene', limit: 500 }],
      ['search_papers', { query: 'graphene', extra: true }],
      ['get_paper', { id: 'not an id' }],
      // An address in the app, but no id OpenAlex or arXiv can answer.
      ['get_paper', { id: 'https://openreview.net/forum?id=5pShDP8LSm' }],
      ['find_open_access', { doi: '2603.01234' }],
    ] as const) {
      const { answer } = await callTool(env, name, args);
      assert.equal(answer.result?.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(answer.result?.structuredContent?.code, 'INVALID_ARGUMENTS');
    }
    // A model correcting itself reads every kind of id the tool takes.
    const { answer } = await callTool(env, 'get_paper', { id: 'not an id' });
    assert.match(String(answer.result?.structuredContent?.message), /PubMed id/);
    const listed = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const getPaper = listed.answer.result?.tools?.find(tool => tool.name === 'get_paper');
    assert.match(String(getPaper?.description), /PubMed id/);
    assert.deepEqual(calls, []);
  });
});

test("search_papers reads a source named in the provider's own spelling", async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_WORK] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const hosts = (from: number) => calls.slice(from).map(url => new URL(url).hostname).sort();
    // Separate environments, so each search finds arXiv's seat free.
    const arxiv = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['arXiv'] });
    assert.equal(arxiv.answer.result?.isError, undefined);
    assert.deepEqual(hosts(0), ['export.arxiv.org']);
    const before = calls.length;
    const both = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['OpenAlex', 'ARXIV'] });
    assert.equal(both.answer.result?.isError, undefined);
    assert.deepEqual(hosts(before), ['api.openalex.org', 'export.arxiv.org']);

    const twice = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['arxiv', 'arXiv'] });
    assert.equal(twice.answer.result?.structuredContent?.code, 'INVALID_ARGUMENTS', 'one source named twice');
  });
});

test('a caller past its minute allowance is refused before any provider is asked', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W')) return Response.json(OPENALEX_WORK);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const env = routeEnv();
    let refusal: RpcAnswer | null = null;
    for (let attempt = 0; attempt < 200 && !refusal; attempt += 1) {
      const { answer } = await callTool(env, 'get_paper', { id: 'W4400000001' }, attempt);
      if (answer.result?.isError) refusal = answer;
    }
    assert.ok(refusal, 'the allowance ends');
    assert.equal(refusal.result?.structuredContent?.code, 'PROVIDER_RATE_LIMITED');
    assert.ok(Number(refusal.result?.structuredContent?.retryAfterSeconds) > 0);
    const before = calls.length;
    await callTool(env, 'get_paper', { id: 'W4400000001' });
    assert.equal(calls.length, before, 'a refused call asks nothing upstream');
    // Another address still has its own allowance.
    const other = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_paper', arguments: { id: 'W4400000001' } } }, { ip: '198.51.100.9' });
    assert.equal(other.answer.result?.isError, undefined);
  });
});

test('without the caller secret a tool call fails closed', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const { answer } = await callTool(routeEnv({ PDF_RATE_LIMIT_SECRET: undefined }), 'get_paper', { id: 'W4400000001' });
    assert.equal(answer.result?.isError, true);
    assert.equal(answer.result?.structuredContent?.code, 'PROVIDER_QUOTA_NOT_CONFIGURED');
    assert.deepEqual(calls, []);
  });
});

// The in-memory ledger, with the tier, kind and units of each OpenAlex reservation it took.
function tallyingLedger() {
  const ledger = inMemoryQuotaLedger();
  const tallies: string[] = [];
  const binding = {
    idFromName: (name: string): unknown => name,
    get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body || '{}')) as { tally?: string; amount?: number };
        if (body.tally) tallies.push(`${body.tally} ${body.amount}`);
        return ledger.binding!.get(name as DurableObjectId).fetch(url, init);
      },
    }),
  } as WorkerEnv['REQUEST_QUOTA_LEDGER'];
  return { binding, tallies };
}

test('every billed OpenAlex miss of a tool spends the lowest tier, where ENG-91 puts agents', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_LAB_PREPRINT] });
    if (url.startsWith('https://api.openalex.org/works/')) return Response.json(OPENALEX_WORK);
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response('down', { status: 503 });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const ledger = tallyingLedger();
    const env = routeEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
    // A DOI the relay cannot carry in its path is a one-work list, and so is
    // the arXiv fallback: a reader opening a paper spends those in the
    // essential tier.
    await callTool(env, 'get_paper', { id: '10.1234/../example.2026.1' });
    await callTool(env, 'search_papers', { query: 'graphene strain', sources: ['openalex'] });
    await callTool(env, 'get_paper', { id: '2603.01234' });
    // One work by id is free and reserves nothing.
    await callTool(env, 'get_paper', { id: 'W4400000001' });
    assert.deepEqual(ledger.tallies, ['exploration.list 1', 'exploration.search 10', 'exploration.list 1']);
  });
});

test("a tool takes arXiv's seat only when no reader has booked it, and books none ahead", async () => {
  // The last millisecond of a public (even) period. The odd period after it
  // is not a public seat, so the next one a reader can take starts 3,001 ms
  // later, and the reader asks then.
  let frozen = EVEN_ARXIV_PERIOD + 3_000 - 1;
  const clock = mock.method(Date, 'now', () => frozen);
  try {
    await withUpstream(url => {
      if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
      if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_WORK] });
      throw new Error(`unexpected upstream ${url}`);
    }, async calls => {
      const env = routeEnv();
      const arxivCalls = () => calls.filter(url => url.startsWith('https://export.arxiv.org/')).length;
      const first = await callTool(env, 'get_paper', { id: '2603.01234' });
      assert.equal((first.answer.result?.structuredContent?.paper as { arxivId?: string })?.arxivId, '2603.01234', 'a free seat is taken');

      // This period's seat is taken, and the next public one is left to readers.
      const refused = await callTool(env, 'get_paper', { id: '2603.09999' });
      assert.equal(refused.answer.result?.isError, true);
      assert.equal(refused.answer.result?.structuredContent?.code, 'PROVIDER_RATE_LIMITED');
      // The next public seat starts 3,001 ms away.
      assert.equal(refused.answer.result?.structuredContent?.retryAfterSeconds, 4);
      const searched = await callTool(env, 'search_papers', { query: 'graphene strain' });
      const unavailable = searched.answer.result?.structuredContent?.unavailable as Array<{ source: string; code: string }>;
      assert.deepEqual(unavailable.map(entry => [entry.source, entry.code]), [['arxiv', 'PROVIDER_RATE_LIMITED']]);
      assert.equal(arxivCalls(), 1, 'a refused tool call reaches arXiv with nothing');

      frozen += 3_001;
      const reader = await reportApi.fetch(new Request('https://papertok-report-api.example/arxiv?id_list=2603.09999', {
        headers: { 'cf-connecting-ip': '203.0.113.5' },
      }), env);
      assert.equal(reader.status, 200, 'a reader still gets the next public seat');
      assert.equal(arxivCalls(), 2);
    });
  } finally {
    clock.mock.restore();
  }
});

test("a tool takes only a public seat of arXiv's beat, as a reader's request does", async () => {
  // An odd period: its seat is free, but it is left to the Worker's own callers.
  const clock = mock.method(Date, 'now', () => EVEN_ARXIV_PERIOD + 3_000);
  try {
    await withUpstream(url => {
      if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
      throw new Error(`unexpected upstream ${url}`);
    }, async calls => {
      const env = routeEnv();
      const searched = await callTool(env, 'search_papers', { query: 'graphene strain', sources: ['arxiv'] });
      assert.equal(searched.answer.result?.structuredContent?.code, 'SOURCES_UNAVAILABLE');
      assert.equal(searched.answer.result?.structuredContent?.retryAfterSeconds, 3);
      assert.deepEqual(calls, []);
      // arXiv was idle: each tool tells the model the refusal is PaperTok's
      // pacing and how often it happens, not that arXiv is busy.
      const tools = (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).answer.result?.tools;
      for (const name of ['search_papers', 'get_paper']) {
        const description = String(tools?.find(tool => tool.name === name)?.description);
        assert.doesNotMatch(description, /busy/, name);
        assert.match(description, /PaperTok's arXiv pacing .* one try in two/, name);
      }
    });
  } finally {
    clock.mock.restore();
  }
});

test("a tool takes a public seat of arXiv's beat at any moment of its period, in search_papers and get_paper", async () => {
  // Early, in the middle and at the end of a public period.
  let frozen = EVEN_ARXIV_PERIOD;
  const clock = mock.method(Date, 'now', () => frozen);
  try {
    await withUpstream(url => {
      if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
      throw new Error(`unexpected upstream ${url}`);
    }, async calls => {
      for (const intoPeriodMs of [100, 1_500, 2_900]) {
        frozen = EVEN_ARXIV_PERIOD + intoPeriodMs;
        const searched = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['arxiv'] });
        assert.equal(searched.answer.result?.isError, undefined, `search_papers ${intoPeriodMs} ms into the period`);
        const looked = await callTool(routeEnv(), 'get_paper', { id: '2603.01234' });
        assert.equal((looked.answer.result?.structuredContent?.paper as { arxivId?: string }).arxivId, '2603.01234', `get_paper ${intoPeriodMs} ms into the period`);
      }
      assert.equal(calls.length, 6);
    });
  } finally {
    clock.mock.restore();
  }
});

test("a reader who comes after a tool in a public period's first two seconds finds no arXiv seat", async () => {
  // The cost of a tool taking the current seat: the next public seat is more
  // than the four seconds a reader waits away.
  let frozen = EVEN_ARXIV_PERIOD + 100;
  const clock = mock.method(Date, 'now', () => frozen);
  try {
    await withUpstream(() => new Response(arxivFeed(ARXIV_LAB_ENTRY)), async calls => {
      const env = routeEnv();
      await callTool(env, 'search_papers', { query: 'graphene strain', sources: ['arxiv'] });
      frozen = EVEN_ARXIV_PERIOD + 1_999;
      const reader = await reportApi.fetch(new Request('https://papertok-report-api.example/arxiv?search_query=strain', {
        headers: { 'cf-connecting-ip': '203.0.113.5' },
      }), env);
      assert.equal(reader.status, 429);
      assert.equal(calls.length, 1);
    });
  } finally {
    clock.mock.restore();
  }
});

test("a tool refused arXiv's seat is told to wait until the next seat it can take", async () => {
  let frozen = EVEN_ARXIV_PERIOD + 1;
  const clock = mock.method(Date, 'now', () => frozen);
  try {
    await withUpstream(url => {
      if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
      throw new Error(`unexpected upstream ${url}`);
    }, async calls => {
      const env = routeEnv();
      const search = (query: string) => callTool(env, 'search_papers', { query, sources: ['arxiv'] });
      assert.equal((await search('graphene strain')).answer.result?.isError, undefined, 'a free seat is taken');

      // This public period's seat is taken, and the period after it is not
      // public: the next seat starts 5,999 ms away.
      const refused = await search('strained graphene');
      assert.equal(refused.answer.result?.structuredContent?.code, 'SOURCES_UNAVAILABLE');
      const wait = refused.answer.result?.structuredContent?.retryAfterSeconds as number;
      assert.equal(wait, 6);

      frozen += wait * 1000;
      assert.equal((await search('graphene in the lab')).answer.result?.isError, undefined, 'waiting as told gets the seat');
      assert.equal(calls.length, 2);
    });
  } finally {
    clock.mock.restore();
  }
});

test("a tool told to wait for arXiv's seat finds it open for the whole public period after the wait", async () => {
  // A second and a half into an odd period. The next public period starts
  // 1.5 s later, and its seat is open for its three seconds.
  const refusedAt = EVEN_ARXIV_PERIOD + 4_500;
  let frozen = refusedAt;
  const clock = mock.method(Date, 'now', () => frozen);
  try {
    await withUpstream(url => {
      if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
      // OpenAlex has no record of the preprint, so get_paper returns arXiv's refusal.
      if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [] });
      throw new Error(`unexpected upstream ${url}`);
    }, async () => {
      const env = routeEnv();
      const searched = await callTool(env, 'search_papers', { query: 'graphene strain', sources: ['arxiv'] });
      const looked = await callTool(env, 'get_paper', { id: '2603.01234' });
      for (const [name, { answer }] of [['search_papers', searched], ['get_paper', looked]] as const) {
        assert.equal(answer.result?.structuredContent?.retryAfterSeconds, 2, name);
      }
      // Separate environments, so each retry finds the seat free. The last one
      // comes after the public period.
      for (const [lateMs, refused] of [[0, undefined], [600, undefined], [2_400, undefined], [2_600, true]] as const) {
        frozen = refusedAt + 2_000 + lateMs;
        const retried = await callTool(routeEnv(), 'get_paper', { id: '2603.01234' });
        assert.equal(retried.answer.result?.isError, refused, `a retry ${lateMs} ms after the wait`);
      }
      // Neither tool tells the model that a retry a second late is refused.
      const tools = (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).answer.result?.tools;
      for (const name of ['search_papers', 'get_paper']) {
        assert.doesNotMatch(String(tools?.find(tool => tool.name === name)?.description), /refused again/, name);
      }
    });
  } finally {
    clock.mock.restore();
  }
});

test('a tool failure leaves a log line with the tool and code, never the arguments', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    await withUpstream(url => {
      if (url.startsWith('https://api.unpaywall.org/')) return new Response('down', { status: 500 });
      throw new Error(`unexpected upstream ${url}`);
    }, async () => {
      await callTool(routeEnv({ PDF_RATE_LIMIT_SECRET: undefined }), 'get_paper', { id: 'W4400000001' });
      await callTool(routeEnv(), 'find_open_access', { doi: '10.1234/secret.doi.4242' });
      await callTool(routeEnv(), 'get_paper', { id: 'not an id' });
    });
    const lines = warn.mock.calls.map(call => JSON.parse(String(call.arguments[0])));
    assert.deepEqual(lines, [
      { route: '/mcp', tool: 'get_paper', code: 'PROVIDER_QUOTA_NOT_CONFIGURED', status: 503 },
      { route: '/mcp', tool: 'find_open_access', code: 'UPSTREAM_UNAVAILABLE', status: 500 },
    ], 'a client mistake is not logged, as a 400 is not');
  } finally {
    warn.mock.restore();
  }
});

const POSTHOG = 'https://eu.i.posthog.com/';

// One request as `instrumentation.ts` runs it, with its log lines, and the
// PostHog reports it sent (to the stubbed fetch) once it is done.
async function oneRequest<T>(env: WorkerEnv, calls: string[], run: () => Promise<T>) {
  const warn = mock.method(console, 'warn', () => {});
  const pending: Promise<unknown>[] = [];
  const before = calls.length;
  try {
    const result = await trackErrors(env, { waitUntil: promise => { pending.push(promise); } }, 'http', run);
    await Promise.all(pending);
    const lines = warn.mock.calls.map(call => String(call.arguments[0]))
      .filter(line => line.startsWith('{"route":"/mcp"'))
      .map(line => JSON.parse(line) as Record<string, unknown>);
    return { result, lines, reports: calls.slice(before).filter(url => url.startsWith(POSTHOG)).length };
  } finally {
    warn.mock.restore();
  }
}

test('a search its sources only rate limited is logged as 429s and not reported as a server error', async () => {
  await withUpstream(url => {
    if (url.startsWith(POSTHOG)) return Response.json({});
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response('Rate exceeded.', { status: 429, headers: { 'retry-after': '30' } });
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'retry-after': '120' } });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    // Separate environments, so the second search does not wait for arXiv's beat.
    const arxivEnv = routeEnv({ POSTHOG_PROJECT_TOKEN: 'phc_test' });
    const arxivOnly = await oneRequest(arxivEnv, calls, () => callTool(arxivEnv, 'search_papers', { query: 'graphene', sources: ['arxiv'] }));
    assert.deepEqual(arxivOnly.lines, [{ route: '/mcp', tool: 'search_papers', source: 'arxiv', code: 'UPSTREAM_RATE_LIMITED', status: 429 }]);
    assert.equal(arxivOnly.reports, 0);
    const arxivAnswer = arxivOnly.result.answer;
    assert.equal(arxivAnswer.result?.isError, true);
    assert.equal(arxivAnswer.result?.structuredContent?.code, 'SOURCES_UNAVAILABLE');
    assert.equal(arxivAnswer.result?.structuredContent?.retryAfterSeconds, 30);

    const bothEnv = routeEnv({ POSTHOG_PROJECT_TOKEN: 'phc_test' });
    const both = await oneRequest(bothEnv, calls, () => callTool(bothEnv, 'search_papers', { query: 'graphene' }));
    const bothAnswer = both.result.answer;
    assert.equal(bothAnswer.result?.structuredContent?.retryAfterSeconds, 30, 'the client can retry once one source reopens');
    assert.deepEqual(both.lines.map(line => [line.source, line.status]), [['openalex', 429], ['arxiv', 429]]);
    assert.equal(both.reports, 0);
  });
});

test('a search source that fails while the other answers still leaves its line and report', async () => {
  await withUpstream(url => {
    if (url.startsWith(POSTHOG)) return Response.json({});
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED);
    if (url.startsWith('https://api.openalex.org/works?') && url.includes('search=graphene')) return Response.json({ error: 'Service unavailable' }, { status: 503 });
    // An answer the relay passes on but the tool cannot read.
    if (url.startsWith('https://api.openalex.org/works?')) return new Response('<html>maintenance</html>', { headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const env = routeEnv({ POSTHOG_PROJECT_TOKEN: 'phc_test' });
    const down = await oneRequest(env, calls, () => callTool(env, 'search_papers', { query: 'graphene' }));
    const answer = down.result.answer;
    assert.equal(answer.result?.isError, undefined);
    assert.equal((answer.result?.structuredContent?.papers as unknown[]).length, 2);
    assert.deepEqual(down.lines, [{ route: '/mcp', tool: 'search_papers', source: 'openalex', code: 'UPSTREAM_UNAVAILABLE', status: 503 }]);
    assert.equal(down.reports, 1);

    const unreadableEnv = routeEnv({ POSTHOG_PROJECT_TOKEN: 'phc_test' });
    const unreadable = await oneRequest(unreadableEnv, calls, () => callTool(unreadableEnv, 'search_papers', { query: 'strain' }));
    assert.deepEqual(unreadable.lines.map(line => [line.source, line.status]), [['openalex', 503]]);
    assert.equal(unreadable.reports, 1);
  });
});

test('an exception during a tool call is answered under the request id', async () => {
  const error = mock.method(console, 'error', () => {});
  try {
    await withUpstream(NO_UPSTREAM, async () => {
      const ledger = { idFromName: () => 'ledger', get: () => ({ fetch: async () => { throw new Error('ledger down'); } }) };
      const env = routeEnv({ REQUEST_QUOTA_LEDGER: ledger as unknown as WorkerEnv['REQUEST_QUOTA_LEDGER'] });
      const { response, answer } = await callTool(env, 'get_paper', { id: 'W4400000001' }, 42);
      assert.equal(response.status, 500);
      assert.equal(answer.id, 42);
      assert.equal(answer.error?.code, -32603);
    });
  } finally {
    error.mock.restore();
  }
});

test('a ledger that does not answer is an outage to retry, not a configuration fault', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    await withUpstream(NO_UPSTREAM, async calls => {
      const ledger = { idFromName: () => 'ledger', get: () => ({ fetch: async () => new Response('unavailable', { status: 500 }) }) };
      const env = routeEnv({ REQUEST_QUOTA_LEDGER: ledger as unknown as WorkerEnv['REQUEST_QUOTA_LEDGER'] });
      const { answer } = await callTool(env, 'get_paper', { id: 'W4400000001' });
      assert.equal(answer.result?.isError, true);
      assert.equal(answer.result?.structuredContent?.code, 'QUOTA_LEDGER_UNAVAILABLE');
      assert.ok(Number(answer.result?.structuredContent?.retryAfterSeconds) > 0);
      assert.deepEqual(calls, []);
    });
    assert.deepEqual(warn.mock.calls.map(call => JSON.parse(String(call.arguments[0]))), [
      { route: '/mcp', tool: 'get_paper', code: 'QUOTA_LEDGER_UNAVAILABLE', status: 503 },
    ]);
  } finally {
    warn.mock.restore();
  }
});

test('a message without a method is refused, not taken for a notification', async () => {
  await withUpstream(NO_UPSTREAM, async () => {
    for (const body of [{ jsonrpc: '2.0' }, { jsonrpc: '2.0', method: 5 }, { jsonrpc: '2.0', id: 1 }]) {
      const { response, answer } = await rpc(routeEnv(), body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(answer.error?.code, -32600);
    }
  });
});

test('a search OpenAlex refuses as invalid is not reported as a bad identifier', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ error: 'Invalid query' }, { status: 400 });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED);
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain' });
    const [refused] = answer.result?.structuredContent?.unavailable as Array<{ source: string; code: string; message: string }>;
    assert.equal(refused.source, 'openalex');
    assert.equal(refused.code, 'INVALID_ARGUMENTS');
    assert.doesNotMatch(refused.message, /identifier/i);
  });
});

test('search_papers asks OpenAlex for the work types the app searches', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_WORK] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['openalex'], since: '2026-01-01' });
    const asked = new URL(calls.find(url => url.startsWith('https://api.openalex.org/'))!);
    assert.equal(asked.searchParams.get('filter'), 'type:article|conference-paper|review|preprint,from_publication_date:2026-01-01');
  });
});

test('search_papers bounds arXiv by submission date when since is given', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(ARXIV_FEED);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['arxiv'], since: '2026-01-01' });
    const asked = new URL(calls.find(url => url.startsWith('https://export.arxiv.org/'))!);
    assert.match(asked.searchParams.get('search_query') ?? '', /^all:"graphene strain" AND submittedDate:\[202601010000 TO \d{8}2359\]$/);
  });
});

test('arXiv search and lookup return the conference named in the acceptance comment', async () => {
  const entry = ARXIV_LAB_ENTRY.replace('</entry>', '<arxiv:comment>Accepted at NeurIPS 2026</arxiv:comment></entry>');
  await withUpstream(() => new Response(arxivFeed(entry)), async () => {
    const search = await callTool(routeEnv(), 'search_papers', { query: 'graphene', sources: ['arxiv'] });
    const [listed] = search.answer.result?.structuredContent?.papers as Array<Record<string, unknown>>;
    const lookup = await callTool(routeEnv(), 'get_paper', { id: '2603.01234' });
    const detail = lookup.answer.result?.structuredContent?.paper as Record<string, unknown>;
    for (const paper of [listed, detail]) {
      assert.deepEqual(paper.acceptedConference, { id: 'S4363606243', label: 'NeurIPS', year: 2026, evidence: 'arxiv-comment' });
    }
  });
});

test('one OpenAlex work has one id, whichever tool and identifier found it', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_WORK] });
    if (url.startsWith('https://api.openalex.org/works/')) return Response.json(OPENALEX_WORK);
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'graphene strain', sources: ['openalex'] });
    const [listed] = searched.answer.result?.structuredContent?.papers as Array<{ id: string }>;
    assert.equal(listed.id, 'openalex:W4400000001');
    for (const id of ['W4400000001', 'openalex:W4400000001', '10.1234/example.2026.1']) {
      const { answer } = await callTool(env, 'get_paper', { id });
      assert.equal((answer.result?.structuredContent?.paper as { id: string }).id, listed.id, id);
    }
  });
});

test('OpenAlex works sharing a DOI keep their own search taxonomy', async () => {
  const topic = { id: 'T42', display_name: 'Materials' };
  const work = (id: string) => ({ ...OPENALEX_WORK, id: `https://openalex.org/${id}`, ids: { openalex: `https://openalex.org/${id}` } });
  await withUpstream(url => {
    if (url.includes('search=')) return Response.json({ results: [{ ...work('W1001'), topics: [topic] }] });
    return Response.json(work(new URL(url).pathname.split('/').at(-1)!));
  }, async calls => {
    await callTool(routeEnv(), 'search_papers', { query: 'materials', sources: ['openalex'] });
    for (const id of ['W1002', 'W1001']) {
      const { answer } = await callTool(routeEnv(), 'get_paper', { id });
      const paper = answer.result?.structuredContent?.paper as Record<string, unknown>;
      assert.equal(paper.id, `openalex:${id}`);
      assert.deepEqual(paper.topics, id === 'W1001' ? [topic] : undefined);
      assert.deepEqual(paper.categories, id === 'W1001' ? ['Materials'] : undefined);
    }
    assert.equal(calls.length, 3);
  });
});

test('a deduplicated search cannot lend one OpenAlex work the arXiv identifier of another', async () => {
  const works = [
    { ...OPENALEX_WORK, topics: [{ id: 'T42', display_name: 'Materials' }] },
    { ...OPENALEX_LAB_PREPRINT, doi: OPENALEX_WORK.doi },
  ];
  await withUpstream(url => url.includes('search=')
    ? Response.json({ results: works })
    : new Response(arxivFeed(ARXIV_LAB_ENTRY)), async calls => {
    const search = await callTool(routeEnv(), 'search_papers', { query: 'materials', sources: ['openalex'] });
    const [listed] = search.answer.result?.structuredContent?.papers as Array<{ arxivId: string }>;
    assert.equal(listed.arxivId, '2603.01234');
    const { answer } = await callTool(routeEnv(), 'get_paper', { id: listed.arxivId });
    const paper = answer.result?.structuredContent?.paper as Record<string, unknown>;
    assert.deepEqual(paper.categories, ['cond-mat.mes-hall']);
    assert.equal(paper.topics, undefined);
    assert.equal(calls.length, 2);
  });
});

for (const scenario of ['marker eviction', 'W1001 first', 'W1002 first'] as const) {
  test(`arXiv detail cannot inherit OpenAlex taxonomy through a DOI after ${scenario}`, async () => {
    const first = { ...OPENALEX_WORK, id: 'https://openalex.org/W1001', ids: { openalex: 'https://openalex.org/W1001' },
      topics: [{ id: 'T42', display_name: 'Materials' }] };
    const second = { ...OPENALEX_LAB_PREPRINT, id: 'https://openalex.org/W1002', ids: { openalex: 'https://openalex.org/W1002' }, doi: first.doi };
    const pages = scenario === 'marker eviction' ? [[first], [first, second]]
      : scenario === 'W1001 first' ? [[first], [second]] : [[second], [first]];
    const preprint = ARXIV_LAB_ENTRY.replace('</entry>', '<arxiv:doi>10.1234/example.2026.1</arxiv:doi></entry>');
    await withUpstream(url => {
      if (url.startsWith('https://export.arxiv.org/')) return new Response(arxivFeed(preprint));
      return Response.json({ results: pages.shift() });
    }, async (calls, evict) => {
      for (const query of ['materials', 'graphene']) {
        await callTool(routeEnv(), 'search_papers', { query, sources: scenario === 'marker eviction' ? ['openalex', 'arxiv'] : ['openalex'] });
      }
      if (scenario === 'marker eviction') evict(key => new URL(key).pathname.includes('/ambiguous/'));
      const { answer } = await callTool(routeEnv(), 'get_paper', { id: '2603.01234' });
      const paper = answer.result?.structuredContent?.paper as Record<string, unknown>;
      assert.equal(paper.id, '2603.01234');
      assert.deepEqual(paper.categories, ['cond-mat.mes-hall']);
      assert.equal(paper.topics, undefined);
      assert.equal(paper.concepts, undefined);
      assert.deepEqual(paper.taxonomySources, { categories: 'arxiv' });
      assert.equal(calls.length, scenario === 'marker eviction' ? 5 : 3);
    });
  });
}

test('only an explicit arXiv ID or arXiv location on the live work unlocks cached categories', async () => {
  const misleading = 'https://doi.org/10.1234/arxiv:2603.01234';
  const records = [
    { ...OPENALEX_WORK, doi: misleading, locations: [{ landing_page_url: 'https://example.org/arxiv.org/abs/2603.01234' }] },
    { ...OPENALEX_WORK, doi: 'https://doi.org/10.48550/arXiv.2603.01234' },
    { ...OPENALEX_WORK, ids: { ...OPENALEX_WORK.ids, arxiv: '2603.01234v2' } },
    OPENALEX_LAB_PREPRINT,
  ];
  await withUpstream(url => url.startsWith('https://export.arxiv.org/')
    ? new Response(arxivFeed(ARXIV_LAB_ENTRY)) : Response.json(records.shift()), async () => {
    await callTool(routeEnv(), 'search_papers', { query: 'graphene', sources: ['arxiv'] });
    for (const [expectedId, matched] of [[undefined, false], ['2603.01234', false], ['2603.01234', true], ['2603.01234', true]] as const) {
      const { answer } = await callTool(routeEnv(), 'get_paper', { id: '10.1234/example.2026.1' });
      const paper = answer.result?.structuredContent?.paper as Record<string, unknown>;
      assert.equal(paper.arxivId, expectedId);
      assert.deepEqual(paper.categories, matched ? ['cond-mat.mes-hall'] : undefined);
    }
  });
});

test('an invalid provider work URL ending in a known W ID cannot reuse its subjects', async () => {
  await withUpstream(url => url.includes('search=')
    ? Response.json({ results: [{ ...OPENALEX_WORK, topics: [{ id: 'T42', display_name: 'Materials' }] }] })
    : Response.json({ ...OPENALEX_WORK, id: 'https://example.org/W4400000001' }), async () => {
    await callTool(routeEnv(), 'search_papers', { query: 'materials', sources: ['openalex'] });
    const { answer } = await callTool(routeEnv(), 'get_paper', { id: 'W4400000001' });
    assert.equal(answer.result?.structuredContent?.code, 'UPSTREAM_UNAVAILABLE');
  });
});

test('cached OpenAlex evidence rules out a conflicting arXiv record with the same DOI', async () => {
  const topic = { id: 'T42', display_name: 'Materials' };
  const work = { ...OPENALEX_WORK, ids: { ...OPENALEX_WORK.ids, arxiv: 'arxiv:2603.01234v2' }, topics: [topic] };
  await withUpstream(url => {
    if (url.startsWith('https://export.arxiv.org/')) return new Response(arxivFeed(ARXIV_PREPRINT_ENTRY));
    return Response.json(url.includes('search=') ? { results: [work] } : OPENALEX_WORK);
  }, async calls => {
    for (const source of ['openalex', 'arxiv']) {
      await callTool(routeEnv(), 'search_papers', { query: 'materials', sources: [source] });
    }
    const { answer } = await callTool(routeEnv(), 'get_paper', { id: 'W4400000001' });
    const paper = answer.result?.structuredContent?.paper as Record<string, unknown>;
    assert.deepEqual(paper.topics, [topic]);
    assert.deepEqual(paper.categories, ['Materials']);
    assert.equal(paper.arxivId, undefined);
    assert.equal(calls.length, 3);
  });
});

test('missing, expired, evicted and unavailable taxonomy entries leave the provider lookup usable', async () => {
  for (const scenario of ['miss', 'expiry', 'evict', 'read', 'write'] as const) {
    await withUpstream(url => {
      if (url.includes('search=')) return Response.json({ results: [{ ...OPENALEX_WORK, topics: [{ id: 'T42', display_name: 'Materials' }] }] });
      return Response.json(OPENALEX_WORK);
    }, async calls => {
      const lookup = async () => {
        const { answer } = await callTool(routeEnv(), 'get_paper', { id: 'W4400000001' });
        const paper = answer.result?.structuredContent?.paper as Record<string, unknown>;
        assert.equal(paper.title, OPENALEX_WORK.title, scenario);
        return paper.categories;
      };
      if (scenario !== 'miss') {
        const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'materials', sources: ['openalex'] });
        const papers = answer.result?.structuredContent?.papers as Array<{ categories?: string[] }>;
        assert.deepEqual(papers[0].categories, ['Materials'], scenario);
      }
      if (scenario === 'expiry') {
        const clock = mock.method(Date, 'now', () => EVEN_ARXIV_PERIOD + 599_999);
        try {
          assert.deepEqual(await lookup(), ['Materials']);
          clock.mock.mockImplementation(() => EVEN_ARXIV_PERIOD + 600_000);
          assert.equal(await lookup(), undefined);
        } finally {
          clock.mock.restore();
        }
      } else {
        assert.equal(await lookup(), undefined, scenario);
      }
      assert.equal(calls.length, scenario === 'miss' ? 1 : scenario === 'expiry' ? 3 : 2);
    }, scenario === 'miss' || scenario === 'expiry' ? undefined : scenario);
  }
});

test('a single-source search cannot supply taxonomy to the other provider through their shared DOI', async () => {
  const topic = { id: 'https://openalex.org/T42', display_name: 'Materials' };
  const work = { ...OPENALEX_WORK, topics: [topic] };
  for (const source of ['openalex', 'arxiv']) {
    await withUpstream(url => {
      if (url.startsWith('https://export.arxiv.org/')) return new Response(arxivFeed(ARXIV_PREPRINT_ENTRY));
      return Response.json(url.includes('search=') ? { results: [work] } : work);
    }, async calls => {
      await callTool(routeEnv(), 'search_papers', { query: 'graphene', sources: [source] });
      const id = source === 'arxiv' ? '10.1234/example.2026.1' : '2603.09999';
      const { answer } = await callTool(routeEnv(), 'get_paper', { id });
      const paper = answer.result?.structuredContent?.paper as Record<string, unknown>;
      assert.deepEqual(paper.topics, source === 'arxiv' ? [topic] : undefined);
      assert.deepEqual(paper.categories, source === 'arxiv' ? ['Materials'] : ['cond-mat.mtrl-sci']);
      if (source === 'openalex') assert.equal(paper.peerReviewed, undefined);
      assert.equal(calls.length, 2);
    });
  }
});

test("detail keeps only the taxonomies whose provider IDs its lookup resolves", async () => {
  const conceptual = { ...OPENALEX_WORK, ids: { ...OPENALEX_WORK.ids, pmid: 'https://pubmed.ncbi.nlm.nih.gov/123/' }, concepts: [{ id: 'https://openalex.org/C1', display_name: 'Graphene', level: 2, score: 0.9 }] };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [conceptual] });
    if (url.startsWith('https://api.openalex.org/works/')) return Response.json({ ...OPENALEX_WORK, ids: { ...OPENALEX_WORK.ids, arxiv: 'arxiv:2603.09999v2' }, topics: [{ id: 'T42', display_name: 'Materials' }] });
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(ARXIV_PREPRINT_ENTRY));
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    type Relayed = { id: string; categories?: string[]; concepts?: Array<{ id: string }>; taxonomySources?: Record<string, string> };
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'graphene sheets under strain' });
    const [listed] = searched.answer.result?.structuredContent?.papers as Relayed[];
    assert.deepEqual([listed.id, listed.categories], ['openalex:W4400000001', ['cond-mat.mtrl-sci']]);
    for (const id of [listed.id, '10.1234/example.2026.1', 'pmid:123', '2603.09999']) {
      const { answer } = await callTool(routeEnv(), 'get_paper', { id });
      const paper = answer.result?.structuredContent?.paper as Relayed;
      if (id === '2603.09999') assert.equal('peerReviewed' in paper, false);
      assert.deepEqual(paper.categories, ['cond-mat.mtrl-sci'], id);
      assert.equal(paper.concepts?.[0].id, id === '2603.09999' ? undefined : 'https://openalex.org/C1', id);
      assert.deepEqual(paper.taxonomySources, { categories: 'arxiv', ...(id !== '2603.09999' && { concepts: 'openalex', topics: 'openalex' }) }, id);
    }
    assert.equal(calls.length, 6);
    const tools = (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).answer.result?.tools;
    for (const name of ['search_papers', 'get_paper']) {
      const description = String(tools?.find(tool => tool.name === name)?.description);
      assert.match(description, /concept names/, name);
      assert.match(description, /arXiv categories/, name);
    }
  });
});

test('a work without concepts is listed with its topic names as categories, in search and detail', async () => {
  const topical = { ...OPENALEX_WORK, topics: [{ display_name: 'Unidentified topic' }, { id: 'T2' }, { id: 'https://openalex.org/T1', display_name: 'Graphene and 2D materials', score: 0.99 }] };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [topical] });
    if (url.startsWith('https://api.openalex.org/works/')) return Response.json(topical);
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    type Relayed = { id: string; categories?: string[] };
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'graphene sheets under strain', sources: ['openalex'] });
    const [listed] = searched.answer.result?.structuredContent?.papers as Relayed[];
    assert.deepEqual(listed.categories, ['Graphene and 2D materials']);
    const { answer } = await callTool(env, 'get_paper', { id: listed.id });
    const detail = answer.result?.structuredContent?.paper as Relayed & { topics?: Array<{ id: string }> };
    assert.deepEqual(detail.categories, ['Graphene and 2D materials']);
    assert.deepEqual(detail.topics?.map(topic => topic.id), ['T2', 'https://openalex.org/T1']);
    const tools = (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).answer.result?.tools;
    assert.match(String(tools?.find(tool => tool.name === 'search_papers')?.description), /topic names/);
  });
});

test('get_paper does not present another work as a DOI the one-work list did not match', async () => {
  await withUpstream(url => {
    // OpenAlex reads `,` in the filter as another clause and answers with whatever matched.
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [OPENALEX_WORK] });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callTool(routeEnv(), 'get_paper', { id: '10.1234/../x,title.search:graphene' });
    assert.equal(answer.result?.isError, true);
    assert.equal(answer.result?.structuredContent?.code, 'NOT_FOUND');
  });
});

// ─── Agent tokens and account tools (ENG-91, phase 2a) ───

const AGENT_SECRET = 'test-only-agent-token-secret-of-32-bytes';
const PUBLIC_TOOLS = ['find_open_access', 'get_paper', 'search_papers'];
const ACCOUNT_TOOLS = ['find_similar_papers', 'get_citation_graph', 'get_list', 'list_my_feeds', 'list_my_lists'];
const OWN_DATA_TOOLS = ['get_list', 'list_my_feeds', 'list_my_lists'];

// A real key, so the Worker's own Firestore client signs its token request.
const servicePair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
) as CryptoKeyPair;
const servicePkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', servicePair.privateKey) as ArrayBuffer);
const SERVICE_ACCOUNT = {
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'worker@papertok-test.iam.gserviceaccount.com',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...servicePkcs8))}\n-----END PRIVATE KEY-----`,
  FIREBASE_PROJECT_ID: 'papertok-test',
};

const accountEnv = (extra: Partial<WorkerEnv> = {}) => routeEnv({ MCP_AGENT_TOKEN_SECRET: AGENT_SECRET, ...SERVICE_ACCOUNT, ...extra });
const tokenEnv: WorkerEnv = { MCP_AGENT_TOKEN_SECRET: AGENT_SECRET };

type Scopes = Parameters<typeof mintAgentToken>[2];

// The header an agent sends for `uid`. `issuedAt` defaults to the pinned clock.
async function bearer(uid = 'alice-uid', issuedAt?: number, scopes: Scopes = ['account:read']) {
  return { authorization: `Bearer ${(await mintAgentToken(tokenEnv, uid, scopes, issuedAt)).token}` };
}

async function callAs(env: WorkerEnv, uid: string, name: string, args: unknown, ip?: string, scopes?: Scopes) {
  return rpc(env, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, { headers: await bearer(uid, undefined, scopes), ip });
}

// Firestore's REST API over `documents`, keyed by path. `reads` lists every
// path and collection a request asked for, and `commits` the writes of every
// commit that landed, as the Worker sent them. A commit is refused as
// Firestore refuses it: when a write's precondition does not hold, or when a
// document its transaction read has changed since. `write` changes a document
// as another client would, and `beforeCommit` runs once, as the next commit
// arrives, for a change that lands between a tool's read and its write.
const FIRESTORE_ROOT = 'projects/papertok-test/databases/(default)/documents';
function fakeFirestore(seed: Record<string, object>) {
  const documents = { ...seed };
  const reads: string[] = [];
  const commits: FirestoreWrite[][] = [];
  const versions = new Map<string, number>();
  const transactions = new Map<string, Map<string, number>>();
  const hooks: { beforeCommit?: (writes: FirestoreWrite[]) => void } = {};
  const base = `https://firestore.googleapis.com/v1/${FIRESTORE_ROOT}`;
  const version = (path: string) => versions.get(path) ?? 0;
  const updateTime = (path: string) => new Date(Date.UTC(2026, 0, 1) + version(path) * 1000).toISOString();
  const stored = (path: string) => ({ name: `${FIRESTORE_ROOT}/${path}`, fields: encodeFields(documents[path]), updateTime: updateTime(path) });
  const write = (path: string, data: object | null) => {
    if (data) documents[path] = data;
    else delete documents[path];
    versions.set(path, version(path) + 1);
  };
  const refusal = (status: string) => Response.json({ error: { status } }, { status: status === 'ABORTED' ? 409 : 400 });
  const commit = (body: { writes?: FirestoreWrite[]; transaction?: string }) => {
    const before = hooks.beforeCommit;
    hooks.beforeCommit = undefined;
    before?.(body.writes || []);
    const read = body.transaction ? transactions.get(body.transaction) : undefined;
    if (body.transaction && !read) return refusal('INVALID_ARGUMENT');
    if (read && [...read].some(([path, seen]) => version(path) !== seen)) return refusal('ABORTED');
    // A name in a request body is the document's own, with nothing escaped.
    const writes = (body.writes || []).map(entry => ({ entry, path: entry.update!.name.slice(FIRESTORE_ROOT.length + 1) }));
    for (const { entry, path } of writes) {
      const { exists, updateTime: expected } = entry.currentDocument ?? {};
      if (exists === false && documents[path]) return refusal('ALREADY_EXISTS');
      if (exists === true && !documents[path]) return refusal('NOT_FOUND');
      if (expected !== undefined && (!documents[path] || expected !== updateTime(path))) return refusal('FAILED_PRECONDITION');
    }
    for (const { entry, path } of writes) {
      const fields = decodeFields<Record<string, unknown>>(entry.update!.fields);
      const kept = entry.updateMask
        ? Object.fromEntries(Object.entries(documents[path] ?? {}).filter(([key]) => !entry.updateMask!.fieldPaths.includes(key)))
        : {};
      write(path, { ...kept, ...fields });
    }
    commits.push(body.writes || []);
    return Response.json({ commitTime: new Date(Date.now()).toISOString() });
  };
  const answer = (url: string, init?: RequestInit): Response | undefined => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'service-token', expires_in: 3600 });
    if (!url.startsWith(base)) return undefined;
    const body = init?.body ? JSON.parse(String(init.body)) as {
      documents?: string[]; transaction?: string; writes?: FirestoreWrite[];
      structuredQuery?: { from: Array<{ collectionId: string }>; limit?: number };
    } : {};
    if (url === `${base}:beginTransaction`) {
      const transaction = `transaction-${transactions.size + 1}`;
      transactions.set(transaction, new Map());
      return Response.json({ transaction });
    }
    if (url === `${base}:rollback`) {
      transactions.delete(body.transaction!);
      return Response.json({});
    }
    if (url === `${base}:commit`) return commit(body);
    if (url === `${base}:batchGet`) {
      return Response.json((body.documents || []).map(name => {
        const path = name.slice(FIRESTORE_ROOT.length + 1);
        reads.push(path);
        if (body.transaction) transactions.get(body.transaction)?.set(path, version(path));
        return documents[path] ? { found: stored(path) } : { missing: name };
      }));
    }
    const [encoded, action] = url.slice(base.length + 1).split(':');
    const path = encoded.split('/').map(decodeURIComponent).join('/');
    if (!action) {
      reads.push(path);
      return documents[path] ? Response.json(stored(path)) : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    }
    const collection = `${path}/${body.structuredQuery!.from[0].collectionId}/`;
    reads.push(`${collection}*`);
    const found = Object.keys(documents).filter(key => key.startsWith(collection) && !key.slice(collection.length).includes('/')).sort();
    if (action === 'runAggregationQuery') return Response.json([{ result: { aggregateFields: { count: { integerValue: String(found.length) } } } }]);
    return Response.json(found.slice(0, body.structuredQuery!.limit).map(key => ({ document: stored(key) })));
  };
  return { answer, reads, commits, documents, write, hooks };
}

const withStore = (documents: Record<string, object>, run: (reads: string[], calls: string[]) => Promise<void>) => {
  const store = fakeFirestore(documents);
  return withUpstream((url, init) => store.answer(url, init) ?? NO_UPSTREAM(url), calls => run(store.reads, calls));
};

const structured = <T>(answer: RpcAnswer) => answer.result?.structuredContent as T;

test('a request without credentials is served as before: three tools, and instructions that name no account tool', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    // The same Worker, with and without the account configuration.
    for (const env of [routeEnv(), accountEnv()]) {
      const listed = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.deepEqual(listed.answer.result?.tools?.map(tool => tool.name).sort(), PUBLIC_TOOLS);
      const { answer } = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
      for (const name of ACCOUNT_TOOLS) assert.ok(!String(answer.result?.instructions).includes(name), name);
    }
    assert.deepEqual(calls, []);
  });
});

test('an account tool is no tool to a request without credentials', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const ledger = inMemoryQuotaLedger();
    const env = accountEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
    const unknown = await callTool(env, 'delete_everything', {});
    assert.equal(unknown.answer.error?.code, -32602);
    for (const [name, args] of [
      ['find_similar_papers', { id: '10.1234/example.2026.1' }],
      ['get_citation_graph', { id: '10.1234/example.2026.1' }],
      ['list_my_lists', {}],
      ['get_list', { listId: 'reading' }],
      ['list_my_feeds', {}],
    ] as const) {
      const { response, answer } = await callTool(env, name, args);
      assert.equal(response.status, 200, name);
      assert.deepEqual(answer, unknown.answer, name);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(ledger.calls, [], 'nothing is reserved for a tool the caller does not have');
  });
});

test('a request that presents anything but a valid agent token is refused, whatever it asks', async () => {
  const idToken = fakeIdToken({ aud: 'papertok-test', exp: EVEN_ARXIV_PERIOD / 1000 + 3600 });
  const valid = (await bearer()).authorization;
  const credentials = [
    ['an unknown token', 'Bearer not-a-token'],
    ['a token that expired a minute ago', (await bearer('alice-uid', EVEN_ARXIV_PERIOD - 31 * 60_000)).authorization],
    ['a token signed with another secret', `Bearer ${(await mintAgentToken({ MCP_AGENT_TOKEN_SECRET: 'another-secret-that-is-32-bytes-long!' }, 'alice-uid', ['account:read'])).token}`],
    ['a changed token', `${valid.slice(0, -3)}AAA`],
    ["the reader's Firebase ID token", `Bearer ${idToken}`],
    ['another scheme', 'Basic YWxpY2U6c2VjcmV0'],
    ['the token without a scheme', valid.slice('Bearer '.length)],
    ['an empty header', ''],
  ];
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_paper', arguments: { id: 'W4400000001' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_my_lists', arguments: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    '{"jsonrpc":',
  ];
  await withUpstream(NO_UPSTREAM, async calls => {
    const ledger = inMemoryQuotaLedger();
    const env = accountEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
    for (const [why, authorization] of credentials) {
      for (const message of messages) {
        const { response, answer } = await rpc(env, message, { headers: { authorization } });
        const asked = `${why}: ${typeof message === 'string' ? message : message.method}`;
        assert.equal(response.status, 401, asked);
        assert.equal(response.headers.get('www-authenticate'), 'Bearer', asked);
        assert.equal(response.headers.get('cache-control'), 'no-store', asked);
        assert.deepEqual([answer.jsonrpc, answer.id, answer.error?.code, answer.result], ['2.0', null, -32001, undefined], asked);
      }
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(ledger.calls, []);
  });
});

test('a Worker without the token secret answers a presented token with 503, and anonymous requests as before', async () => {
  await withUpstream(NO_UPSTREAM, async () => {
    const env = accountEnv({ MCP_AGENT_TOKEN_SECRET: undefined });
    for (const method of ['initialize', 'tools/list', 'ping']) {
      const { response, answer } = await rpc(env, { jsonrpc: '2.0', id: 1, method }, { headers: await bearer() });
      assert.equal(response.status, 503, method);
      assert.deepEqual([answer.id, answer.error?.code, answer.result], [null, -32002, undefined], method);
    }
    const anonymous = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(anonymous.answer.result?.tools?.map(tool => tool.name).sort(), PUBLIC_TOOLS);
  });
});

test('a request with an agent token lists the account tools and is told about them', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const env = accountEnv();
    const headers = await bearer();
    const listed = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers });
    const tools = listed.answer.result?.tools || [];
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...PUBLIC_TOOLS, ...ACCOUNT_TOOLS].sort());
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      // Only the tools that read the account's own documents reach nothing outside PaperTok.
      assert.equal(tool.annotations?.openWorldHint, !OWN_DATA_TOOLS.includes(tool.name), tool.name);
    }
    const anonymous = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    const signedIn = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }, { headers });
    const instructions = String(signedIn.answer.result?.instructions);
    assert.ok(instructions.startsWith(String(anonymous.answer.result?.instructions)));
    for (const name of ACCOUNT_TOOLS) assert.ok(instructions.includes(name), name);
    assert.equal(signedIn.answer.result?.protocolVersion, '2025-06-18');
    assert.deepEqual((await rpc(env, { jsonrpc: '2.0', id: 9, method: 'ping' }, { headers })).answer.result, {});
    assert.deepEqual(calls, []);
  });
});

test('calls with an agent token share one allowance per account, whatever address they come from', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W')) return Response.json(OPENALEX_WORK);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const env = accountEnv();
    const addresses = ['192.0.2.7', '198.51.100.9', '203.0.113.4'];
    // Thirty calls, ten from each of three addresses.
    for (let call = 0; call < 30; call += 1) {
      const { answer } = await callAs(env, 'alice-uid', 'get_paper', { id: 'W4400000001' }, addresses[call % 3]);
      assert.equal(answer.result?.isError, undefined, `call ${call + 1}`);
    }
    const before = calls.length;
    for (const ip of [...addresses, '203.0.113.200']) {
      const refused = structured<{ code: string; retryAfterSeconds: number }>((await callAs(env, 'alice-uid', 'get_paper', { id: 'W4400000001' }, ip)).answer);
      assert.equal(refused.code, 'PROVIDER_RATE_LIMITED', ip);
      assert.equal(refused.retryAfterSeconds, 60, 'the pinned clock is at the start of a minute');
    }
    assert.equal(calls.length, before, 'a refused call asks nothing upstream');
    // Another account at the same address has its own allowance, and so has the address itself.
    assert.equal((await callAs(env, 'bob-uid', 'get_paper', { id: 'W4400000001' }, addresses[0])).answer.result?.isError, undefined);
    const anonymous = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_paper', arguments: { id: 'W4400000001' } } }, { ip: addresses[0] });
    assert.equal(anonymous.answer.result?.isError, undefined);
    // The address is counted apart from the accounts that call from it: it has its own thirty calls, and no more.
    const anonymousCall = () => rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_paper', arguments: { id: 'W4400000001' } } }, { ip: addresses[0] });
    for (let call = 1; call < 30; call += 1) assert.equal((await anonymousCall()).answer.result?.isError, undefined, `anonymous call ${call + 1}`);
    assert.equal(structured<{ code: string }>((await anonymousCall()).answer).code, 'PROVIDER_RATE_LIMITED');
    // And spending it leaves an account that calls from there its own.
    assert.equal((await callAs(env, 'bob-uid', 'get_paper', { id: 'W4400000001' }, addresses[0])).answer.result?.isError, undefined);
  });
});

test('without the caller secret a call with an agent token fails closed', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const { answer } = await callAs(accountEnv({ PDF_RATE_LIMIT_SECRET: undefined }), 'alice-uid', 'list_my_lists', {});
    assert.equal(structured<{ code: string }>(answer).code, 'PROVIDER_QUOTA_NOT_CONFIGURED');
    assert.deepEqual(calls, []);
  });
});

test('invalid arguments to an account tool are a tool error and reach no provider, store or ledger', async () => {
  await withUpstream(NO_UPSTREAM, async calls => {
    const ledger = inMemoryQuotaLedger();
    const env = accountEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
    for (const [name, args] of [
      ['find_similar_papers', {}],
      ['find_similar_papers', { id: 'not an id' }],
      ['find_similar_papers', { id: '10.1234/example.2026.1', limit: 0 }],
      ['find_similar_papers', { id: '10.1234/example.2026.1', limit: 11 }],
      ['find_similar_papers', { id: '10.1234/example.2026.1', uid: 'bob-uid' }],
      ['get_citation_graph', {}],
      ['get_citation_graph', { id: 'https://openreview.net/forum?id=5pShDP8LSm' }],
      ['get_citation_graph', { id: '10.1234/example.2026.1', limit: 5 }],
      ['list_my_lists', { uid: 'bob-uid' }],
      ['list_my_feeds', { account: 'bob-uid' }],
      ['get_list', {}],
      ['get_list', { listId: '' }],
      ['get_list', { listId: 7 }],
      ['get_list', { listId: '..' }],
      ['get_list', { listId: '../../bob-uid/lists/private' }],
      ['get_list', { listId: 'x'.repeat(161) }],
      // A name Firestore reserves, which it would answer with a 400.
      ['get_list', { listId: '__reading__' }],
      ['get_list', { listId: 'reading', uid: 'bob-uid' }],
      ['get_list', 'reading'],
    ] as const) {
      const { answer } = await callAs(env, 'alice-uid', name, args);
      assert.equal(answer.result?.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(structured<{ code: string }>(answer).code, 'INVALID_ARGUMENTS', `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(ledger.calls, []);
  });
});

// Semantic Scholar's recommendations answer (synthetic), with every field `/related` asks for.
const S2_RECOMMENDATIONS = 'https://api.semanticscholar.org/recommendations/v1/papers/forpaper/';
const recommended = (number: number, extra: Record<string, unknown> = {}) => ({
  paperId: String(number).padStart(40, '0'),
  title: `Recommended paper ${number}`,
  abstract: 'An abstract Semantic Scholar holds.',
  authors: [{ authorId: '77', name: 'Rosa Díaz' }],
  year: 2025,
  externalIds: { DOI: `10.5555/Rec.${number}`, CorpusId: number },
  url: `https://www.semanticscholar.org/paper/${number}`,
  venue: 'arXiv.org',
  publicationDate: '2025-02-03',
  citationCount: 12,
  isOpenAccess: false,
  openAccessPdf: null,
  publicationTypes: ['JournalArticle'],
  ...extra,
});
const collaboration = Array.from({ length: 25 }, (_, index) => ({ authorId: String(index), name: `Author ${index + 1}` }));
const RECOMMENDATIONS = [
  recommended(1, { authors: collaboration }),
  recommended(2, { externalIds: { ArXiv: '2501.00001' } }),
  recommended(3, { externalIds: { DOI: '10.48550/arXiv.2502.00002' } }),
  recommended(4, { externalIds: { DOI: '10.5555/rec.4', ArXiv: '2503.00003v2' } }),
  recommended(5, { externalIds: null, authors: [], year: null }),
  // Nothing to name the paper by.
  { paperId: '5'.repeat(40), title: ' ', externalIds: {} },
  null,
  ...[6, 7, 8, 9, 10, 11, 12].map(number => recommended(number)),
];

test("find_similar_papers names Semantic Scholar's recommendations, and relays no more of each record", async () => {
  await withUpstream(url => {
    if (url.startsWith(S2_RECOMMENDATIONS)) return Response.json({ recommendedPapers: RECOMMENDATIONS });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const ledger = inMemoryQuotaLedger();
    const { answer } = await callAs(accountEnv({ REQUEST_QUOTA_LEDGER: ledger.binding }), 'alice-uid', 'find_similar_papers', { id: 'https://doi.org/10.1234/Example.2026.1' });
    assert.equal(answer.result?.isError, undefined);
    const result = structured<{ papers: Array<Record<string, unknown>>; omitted?: Record<string, number> }>(answer);
    assert.deepEqual(result.papers.slice(0, 5), [
      {
        id: '10.5555/rec.1', title: 'Recommended paper 1', authors: collaboration.slice(0, 20).map(author => author.name),
        year: 2025, doi: '10.5555/rec.1', omitted: { authors: 5 },
      },
      { id: '2501.00001', title: 'Recommended paper 2', authors: ['Rosa Díaz'], year: 2025, arxivId: '2501.00001' },
      // arXiv's own DOI names the preprint, which get_paper finds by its arXiv id.
      { id: '2502.00002', title: 'Recommended paper 3', authors: ['Rosa Díaz'], year: 2025, doi: '10.48550/arxiv.2502.00002', arxivId: '2502.00002' },
      { id: '10.5555/rec.4', title: 'Recommended paper 4', authors: ['Rosa Díaz'], year: 2025, doi: '10.5555/rec.4', arxivId: '2503.00003' },
      { title: 'Recommended paper 5' },
    ]);
    assert.equal(result.papers.length, 10);
    assert.deepEqual(result.omitted, { papers: 2 }, 'twelve recommendations can be named');
    assert.deepEqual(JSON.parse(answer.result?.content?.[0].text || '{}'), result);
    const [asked] = calls.filter(url => url.startsWith(S2_RECOMMENDATIONS));
    assert.ok(asked.startsWith(`${S2_RECOMMENDATIONS}DOI%3A10.1234%2Fexample.2026.1?`), asked);
    // The route charged its miss to the account's share of the providers'
    // minute, as it does a signed-in reader's.
    assert.equal(ledger.calls.filter(key => key.startsWith('provider:')).length, 1);
  });
});

test('find_similar_papers cuts the recommendations at the limit and counts the rest', async () => {
  await withUpstream(url => {
    if (url.startsWith(S2_RECOMMENDATIONS)) return Response.json({ recommendedPapers: RECOMMENDATIONS });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callAs(accountEnv(), 'alice-uid', 'find_similar_papers', { id: '10.1234/example.2026.1', limit: 3 });
    const result = structured<{ papers: Array<{ title: string }>; omitted?: Record<string, number> }>(answer);
    assert.deepEqual(result.papers.map(paper => paper.title), ['Recommended paper 1', 'Recommended paper 2', 'Recommended paper 3']);
    assert.deepEqual(result.omitted, { papers: 9 });
    const few = await callAs(accountEnv(), 'alice-uid', 'find_similar_papers', { id: '10.1234/example.2026.1', limit: 10 });
    assert.deepEqual(structured<{ omitted?: unknown }>(few.answer).omitted, { papers: 2 });
  });
});

test('find_similar_papers asks Semantic Scholar by DOI or arXiv id, looking an OpenAlex or PubMed id up first', async () => {
  const unidentified = { ...OPENALEX_WORK, id: 'https://openalex.org/W4400000999', doi: null, ids: { openalex: 'https://openalex.org/W4400000999' }, primary_location: null };
  await withUpstream(url => {
    if (url.startsWith(S2_RECOMMENDATIONS)) return Response.json({ recommendedPapers: [recommended(1)] });
    if (url.startsWith('https://api.openalex.org/works/W4400000001')) return Response.json(OPENALEX_WORK);
    if (url.startsWith('https://api.openalex.org/works/W4400000123')) return Response.json(OPENALEX_LAB_PREPRINT);
    if (url.startsWith('https://api.openalex.org/works/pmid%3A31452104')) return Response.json(OPENALEX_WORK);
    if (url.startsWith('https://api.openalex.org/works/W4400000999')) return Response.json(unidentified);
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const askedFor = async (id: string) => {
      const before = calls.length;
      const { answer } = await callAs(accountEnv(), 'alice-uid', 'find_similar_papers', { id });
      const asked = calls.slice(before).filter(url => url.startsWith(S2_RECOMMENDATIONS)).map(url => decodeURIComponent(url.slice(S2_RECOMMENDATIONS.length).split('?')[0]));
      return { answer, asked, lookups: calls.slice(before).filter(url => url.startsWith('https://api.openalex.org/')).length };
    };
    for (const [id, paperId, lookups] of [
      ['10.1234/example.2026.1', 'DOI:10.1234/example.2026.1', 0],
      ['arXiv:2603.01234v3', 'ARXIV:2603.01234', 0],
      // Semantic Scholar does not resolve arXiv's own DOIs.
      ['10.48550/arXiv.2603.01234', 'ARXIV:2603.01234', 0],
      ['W4400000001', 'DOI:10.1234/example.2026.1', 1],
      ['pmid:31452104', 'DOI:10.1234/example.2026.1', 1],
      // OpenAlex knows this preprint by its arXiv landing page alone.
      ['openalex:W4400000123', 'ARXIV:2603.01234', 1],
    ] as const) {
      const found = await askedFor(id);
      assert.equal(found.answer.result?.isError, undefined, id);
      assert.deepEqual([found.asked, found.lookups], [[paperId], lookups], id);
    }
    const none = await askedFor('W4400000999');
    assert.equal(structured<{ code: string }>(none.answer).code, 'INVALID_ARGUMENTS');
    assert.match(String(structured<{ message: string }>(none.answer).message), /DOI or arXiv id/);
    assert.deepEqual(none.asked, []);
  });
});

test("find_similar_papers reports Semantic Scholar's refusals and outages, and a paper it has not indexed", async () => {
  const outcomes: Array<[string, () => Response, Record<string, unknown>, Array<Record<string, unknown>>]> = [
    ['rate limited', () => new Response('Too Many Requests', { status: 429 }), { code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 60 },
      [{ route: '/mcp', tool: 'find_similar_papers', code: 'UPSTREAM_RATE_LIMITED', status: 429 }]],
    ['rate limited for seven seconds', () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '7' } }), { code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 7 },
      [{ route: '/mcp', tool: 'find_similar_papers', code: 'UPSTREAM_RATE_LIMITED', status: 429 }]],
    ['down', () => new Response('down', { status: 503 }), { code: 'UPSTREAM_UNAVAILABLE', upstreamStatus: 503 },
      [{ route: '/mcp', tool: 'find_similar_papers', code: 'UPSTREAM_UNAVAILABLE', status: 503 }]],
    ['an answer without recommendations', () => Response.json({ message: 'ok' }), { code: 'UPSTREAM_UNAVAILABLE' },
      [{ route: '/mcp', tool: 'find_similar_papers', code: 'UPSTREAM_UNAVAILABLE', status: 503 }]],
    // Not an outage: the paper has no recommendations to give yet.
    ['not indexed', () => Response.json({ error: 'Paper not found' }, { status: 404 }), { code: 'PAPER_NOT_INDEXED' }, []],
  ];
  const error = mock.method(console, 'error', () => {});
  try {
    for (const [why, upstream, expected, logged] of outcomes) {
      const lines = await mcpLines(() => withUpstream(url => {
        if (url.startsWith(S2_RECOMMENDATIONS)) return upstream();
        throw new Error(`unexpected upstream ${url}`);
      }, async () => {
        const { response, answer } = await callAs(accountEnv(), 'alice-uid', 'find_similar_papers', { id: '10.1234/example.2026.1' });
        assert.equal(response.status, 200, why);
        assert.equal(answer.result?.isError, true, why);
        assert.deepEqual(structured(answer), expected, why);
      }));
      assert.deepEqual(lines, logged, why);
    }
  } finally {
    error.mock.restore();
  }
});

// A work as `/citation-graph` asks OpenAlex for it (synthetic).
const graphWork = (doi: string, citedBy: number) => ({
  id: `https://openalex.org/W${doi.replace(/\D/g, '')}`,
  doi: `https://doi.org/${doi}`,
  title: `Work ${doi}`,
  type: 'article',
  publication_year: 2020,
  publication_date: '2020-05-01',
  authorships: Array.from({ length: 7 }, (_, index) => ({ author: { id: `https://openalex.org/A${index + 1}`, display_name: `Graph Author ${index + 1}` } })),
  abstract_inverted_index: { An: [0], abstract: [1] },
  primary_location: { landing_page_url: `https://doi.org/${doi}`, source: { display_name: 'arXiv (Cornell University)', type: 'repository' } },
  open_access: { is_oa: false },
  cited_by_count: citedBy,
  concepts: [{ id: 'https://openalex.org/C1', display_name: 'Graphene', score: 0.9 }],
  topics: [],
  primary_topic: null,
});
const REFERENCE_DOIS = Array.from({ length: 12 }, (_, index) => `10.7777/ref.${index + 1}`);

// OpenCitations and OpenAlex for the graph of one DOI: twelve references, and
// two citing papers of the forty OpenAlex counts, one of which only
// OpenCitations Meta describes.
function graphUpstream(doi: string): Upstream {
  const encoded = encodeURIComponent(doi);
  return url => {
    if (url.startsWith(`https://api.opencitations.net/index/v2/references/doi:${encoded}`)) {
      return Response.json(REFERENCE_DOIS.map(cited => ({ citing: `doi:${doi}`, cited: `doi:${cited}`, creation: '2026-03' })));
    }
    if (url.startsWith(`https://api.opencitations.net/index/v2/citations/doi:${encoded}`)) {
      return Response.json(['10.8888/cit.1', '10.8888/cit.2'].map(citing => ({ citing: `doi:${citing}`, cited: `doi:${doi}`, creation: '2026-06' })));
    }
    if (url.startsWith('https://api.opencitations.net/meta/v1/metadata/')) {
      return Response.json([{
        id: 'doi:10.8888/cit.2 openalex:W77', title: 'Known to OpenCitations alone', author: 'Lovelace, Ada [orcid:0000-0001-0000-0000]; Hopper, Grace',
        pub_date: '2019-03', venue: 'A Journal [issn:1234-5678]', type: 'journal article', publisher: 'A Publisher [crossref:1]',
      }]);
    }
    if (url.startsWith(`https://api.openalex.org/works/doi:${encoded}`)) return Response.json({ id: 'https://openalex.org/W4400000001', referenced_works: [], cited_by_count: 40 });
    if (url.startsWith('https://api.openalex.org/works?')) {
      const asked = (new URL(url).searchParams.get('filter') || '').replace(/^doi:/, '').split('|');
      return Response.json({ results: asked.filter(found => found !== '10.8888/cit.2').map(found => graphWork(found, Number(found.split('.').pop()))) });
    }
    throw new Error(`unexpected upstream ${url}`);
  };
}

interface GraphResult {
  doi: string;
  references: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  counts: Record<string, number>;
  omitted?: Record<string, number>;
  source?: string;
  partial: boolean;
  degraded: boolean;
}

test('get_citation_graph names up to eight papers of each relation and counts the rest', async () => {
  await withUpstream(graphUpstream('10.1234/example.2026.1'), async () => {
    const { answer } = await callAs(accountEnv(), 'alice-uid', 'get_citation_graph', { id: 'doi:10.1234/Example.2026.1' });
    assert.equal(answer.result?.isError, undefined);
    const graph = structured<GraphResult>(answer);
    const authors = ['Graph Author 1', 'Graph Author 2', 'Graph Author 3', 'Graph Author 4', 'Graph Author 5'];
    // The route orders references by citation count: 12 down to 5.
    assert.deepEqual(graph.references.map(paper => paper.id), [12, 11, 10, 9, 8, 7, 6, 5].map(number => `10.7777/ref.${number}`));
    assert.deepEqual(graph.references[0], {
      id: '10.7777/ref.12', title: 'Work 10.7777/ref.12', authors, year: 2020, doi: '10.7777/ref.12', omitted: { authors: 2 }, citationCount: 12,
    }, 'no abstract, venue, review status, open-access flag or concepts');
    assert.deepEqual(graph.citations, [
      { id: '10.8888/cit.1', title: 'Work 10.8888/cit.1', authors, year: 2020, doi: '10.8888/cit.1', omitted: { authors: 2 }, citationCount: 1 },
      // OpenCitations Meta gives no citation count, so the paper has none.
      { id: '10.8888/cit.2', title: 'Known to OpenCitations alone', authors: ['Lovelace, Ada', 'Hopper, Grace'], year: 2019, doi: '10.8888/cit.2' },
    ]);
    assert.deepEqual(graph.counts, { references: 12, citations: 40 });
    assert.deepEqual(graph.omitted, { references: 4, citations: 38 });
    assert.deepEqual([graph.doi, graph.source, graph.partial, graph.degraded], ['10.1234/example.2026.1', 'opencitations', false, false]);
  });
});

test("get_citation_graph asks for an arXiv id by arXiv's own DOI, and for an OpenAlex id by the work's DOI", async () => {
  await withUpstream(graphUpstream('10.48550/arxiv.2603.01234'), async calls => {
    const { answer } = await callAs(accountEnv(), 'alice-uid', 'get_citation_graph', { id: '2603.01234v2' });
    assert.equal(structured<GraphResult>(answer).doi, '10.48550/arxiv.2603.01234');
    assert.equal(structured<GraphResult>(answer).references.length, 8);
    assert.ok(calls.every(url => !url.startsWith('https://export.arxiv.org/')));
  });
  const graph = graphUpstream('10.1234/example.2026.1');
  await withUpstream(url => (url.startsWith('https://api.openalex.org/works/W4400000001') ? Response.json(OPENALEX_WORK) : graph(url)), async () => {
    const { answer } = await callAs(accountEnv(), 'alice-uid', 'get_citation_graph', { id: 'W4400000001' });
    assert.equal(structured<GraphResult>(answer).doi, '10.1234/example.2026.1');
  });
  // A work OpenAlex holds without a DOI or an arXiv id has no graph to ask for.
  const unidentified = { ...OPENALEX_WORK, doi: null, ids: {}, primary_location: null };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000001')) return Response.json(unidentified);
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callAs(accountEnv(), 'alice-uid', 'get_citation_graph', { id: 'W4400000001' });
    assert.equal(structured<{ code: string }>(answer).code, 'INVALID_ARGUMENTS');
  });
});

test('get_citation_graph says when its sources failed, and relays the refusal of an account past its allowance', async () => {
  const error = mock.method(console, 'error', () => {});
  try {
    await withUpstream(() => new Response('down', { status: 503 }), async () => {
      const { answer } = await callAs(accountEnv(), 'alice-uid', 'get_citation_graph', { id: '10.1234/example.2026.1' });
      assert.equal(answer.result?.isError, undefined);
      const graph = structured<GraphResult>(answer);
      assert.equal(graph.degraded, true, 'empty lists from failed sources are not an empty graph');
      assert.deepEqual([graph.references, graph.citations, graph.omitted], [[], [], undefined]);
    });
    // The route gives each account a share of the providers' minute: one miss here.
    const graph = graphUpstream('10.1234/example.2026.1');
    const other = graphUpstream('10.1234/example.2026.2');
    const lines = await mcpLines(() => withUpstream(url => (url.includes(encodeURIComponent('10.1234/example.2026.2')) ? other(url) : graph(url)), async calls => {
      const env = accountEnv({ PROVIDER_USER_MINUTE_LIMIT: '1' });
      assert.equal((await callAs(env, 'alice-uid', 'get_citation_graph', { id: '10.1234/example.2026.1' })).answer.result?.isError, undefined);
      const before = calls.length;
      const { answer } = await callAs(env, 'alice-uid', 'get_citation_graph', { id: '10.1234/example.2026.2' });
      assert.equal(answer.result?.isError, true);
      assert.deepEqual(structured(answer), { code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: 60 });
      assert.equal(calls.length, before, 'a refused miss asks no provider');
      // Another account still has its share.
      assert.equal((await callAs(env, 'bob-uid', 'get_citation_graph', { id: '10.1234/example.2026.2' })).answer.result?.isError, undefined);
    }));
    assert.deepEqual(lines, [{ route: '/mcp', tool: 'get_citation_graph', code: 'PROVIDER_RATE_LIMITED', status: 429 }]);
  } finally {
    error.mock.restore();
  }
});

const SHARE_ID = 'a'.repeat(32);
const SEVEN_AUTHORS = ['Luis Gómez', 'Ana Pérez', 'Rosa Díaz', 'Mei Chen', 'Omar Haddad', 'Ida Berg', 'Tom Okafor'];
const ALICE_LIBRARY = {
  'users/alice-uid/lists/reading': {
    id: 'reading', name: 'Reading group', emoji: '📚', color: 'teal',
    paperIds: ['2603.01234', '10.1234/example.2026.1', 'openalex:W4400000123'],
    createdAt: new Date('2026-09-01T08:00:00.000Z'), updatedAt: new Date('2026-10-01T09:00:00.000Z'),
    publicShareId: SHARE_ID, publicSyncedAt: new Date('2026-10-01T09:00:05.000Z'),
  },
  'users/alice-uid/lists/thesis': { id: 'thesis', name: 'Thesis', emoji: '🎓', paperIds: [], createdAt: new Date('2026-09-02T08:00:00.000Z') },
  'users/alice-uid/savedPapers/2603.01234': {
    title: 'Strained graphene in the lab', authors: SEVEN_AUTHORS, published: '2026-03-01T10:00:00Z', arxivId: '2603.01234',
    summary: 'We bend graphene and measure it.', primaryCategory: 'cond-mat.mes-hall', categories: ['cond-mat.mes-hall'],
    classificationVersion: 2, savedAt: new Date('2026-09-03T08:00:00.000Z'),
  },
  // A paper saved without a title is stored under its own id, and a DOI's slash is escaped in its document name.
  'users/alice-uid/savedPapers/10.1234%2Fexample.2026.1': { title: '10.1234/example.2026.1', doi: '10.1234/example.2026.1', primaryCategory: '', categories: [] },
  'users/bob-uid/lists/private': { id: 'private', name: "Bob's own", emoji: '🔒', paperIds: ['2603.09999'] },
  'users/bob-uid/savedPapers/2603.09999': { title: 'Graphene sheets under strain' },
};
const READING = { id: 'reading', name: 'Reading group', paperCount: 3, public: true, updatedAt: '2026-10-01T09:00:00.000Z', url: 'https://papertok.app/lists/reading' };
const THESIS = { id: 'thesis', name: 'Thesis', paperCount: 0, public: false, url: 'https://papertok.app/lists/thesis' };
const BOBS_OWN = { id: 'private', name: "Bob's own", paperCount: 1, public: false, url: 'https://papertok.app/lists/private' };

test("list_my_lists returns the token's account's lists and no other account's", async () => {
  await withStore(ALICE_LIBRARY, async reads => {
    const env = accountEnv();
    const { answer } = await callAs(env, 'alice-uid', 'list_my_lists', {});
    assert.equal(answer.result?.isError, undefined);
    assert.deepEqual(structured(answer), { lists: [READING, THESIS] });
    assert.deepEqual(reads, ['users/alice-uid/lists/*']);
    const bob = await callAs(env, 'bob-uid', 'list_my_lists', {});
    assert.deepEqual(structured(bob.answer), { lists: [BOBS_OWN] });
    const nobody = await callAs(env, 'carol-uid', 'list_my_lists', {});
    assert.deepEqual(structured(nobody.answer), { lists: [] });
  });
});

test('list_my_lists returns fifty lists and counts the rest', async () => {
  const many = Object.fromEntries(Array.from({ length: 57 }, (_, index) => {
    const id = `list-${String(index + 1).padStart(2, '0')}`;
    return [`users/alice-uid/lists/${id}`, { id, name: `List ${index + 1}`, paperIds: ['2603.01234'] }];
  }));
  await withStore(many, async () => {
    const result = structured<{ lists: Array<{ id: string }>; omitted?: Record<string, number> }>((await callAs(accountEnv(), 'alice-uid', 'list_my_lists', {})).answer);
    assert.equal(result.lists.length, 50);
    assert.deepEqual([result.lists[0].id, result.lists[49].id], ['list-01', 'list-50']);
    assert.deepEqual(result.omitted, { lists: 7 });
  });
});

test('get_list returns a list with its papers as their saved copies name them', async () => {
  await withStore(ALICE_LIBRARY, async reads => {
    const { answer } = await callAs(accountEnv(), 'alice-uid', 'get_list', { listId: 'reading' });
    assert.equal(answer.result?.isError, undefined);
    assert.deepEqual(structured(answer), {
      ...READING,
      papers: [
        {
          id: '2603.01234', title: 'Strained graphene in the lab', authors: SEVEN_AUTHORS.slice(0, 5),
          published: '2026-03-01T10:00:00Z', arxivId: '2603.01234', omitted: { authors: 2 },
        },
        { id: '10.1234/example.2026.1', doi: '10.1234/example.2026.1' },
        // In the list, with no copy saved: named by its id, and nothing made up for it.
        { id: 'openalex:W4400000123', metadata: 'unavailable' },
      ],
    });
    assert.deepEqual(reads, [
      'users/alice-uid/lists/reading',
      'users/alice-uid/savedPapers/2603.01234',
      'users/alice-uid/savedPapers/10.1234%2Fexample.2026.1',
      'users/alice-uid/savedPapers/openalex:W4400000123',
    ]);
    const empty = await callAs(accountEnv(), 'alice-uid', 'get_list', { listId: 'thesis' });
    assert.deepEqual(structured(empty.answer), { ...THESIS, papers: [] });
  });
});

test('get_list returns a hundred papers of a longer list and counts the rest', async () => {
  const paperIds = Array.from({ length: 120 }, (_, index) => `2601.${String(index + 1).padStart(5, '0')}`);
  await withStore({
    'users/alice-uid/lists/long': { id: 'long', name: 'Long', paperIds: [...paperIds, '', '..', '__name__', 7, { id: 'x' }] },
    'users/alice-uid/savedPapers/2601.00100': { title: 'The hundredth' },
    'users/alice-uid/savedPapers/2601.00101': { title: 'The hundred and first' },
  }, async reads => {
    const result = structured<{ paperCount: number; papers: Array<Record<string, unknown>>; omitted?: Record<string, number> }>(
      (await callAs(accountEnv(), 'alice-uid', 'get_list', { listId: 'long' })).answer,
    );
    assert.equal(result.paperCount, 120, 'entries that are not paper ids are not papers');
    assert.equal(result.papers.length, 100);
    assert.deepEqual(result.papers[99], { id: '2601.00100', title: 'The hundredth' });
    assert.deepEqual(result.omitted, { papers: 20 });
    assert.equal(reads.filter(path => path.includes('/savedPapers/')).length, 100);
  });
});

test('get_list stays inside what an MCP client reads when the saved titles are long', async () => {
  const paperIds = Array.from({ length: 100 }, (_, index) => `2602.${String(index + 1).padStart(5, '0')}`);
  // A saved title can run to the 1,000 characters the rules allow.
  const copies = Object.fromEntries(paperIds.map(id => [`users/alice-uid/savedPapers/${id}`, { title: `${id} ${'long title '.repeat(88)}`.trim() }]));
  await withStore({ 'users/alice-uid/lists/wordy': { id: 'wordy', name: 'Wordy', paperIds }, ...copies }, async () => {
    const { answer } = await callAs(accountEnv(), 'alice-uid', 'get_list', { listId: 'wordy' });
    const result = structured<{ paperCount: number; papers: Array<{ id: string }>; omitted?: Record<string, number> }>(answer);
    assert.equal(result.paperCount, 100);
    assert.ok(result.papers.length >= 30 && result.papers.length < 40, `${result.papers.length} papers of about 1 KB each`);
    assert.deepEqual(result.papers.map(paper => paper.id), paperIds.slice(0, result.papers.length), 'in the list\'s order');
    assert.deepEqual(result.omitted, { papers: 100 - result.papers.length });
    assert.ok(new TextEncoder().encode(answer.result?.content?.[0].text).length < 40_000);
  });
});

test("a list of another account is not found, whatever the request says", async () => {
  await withStore(ALICE_LIBRARY, async reads => {
    const env = accountEnv();
    const { answer } = await callAs(env, 'bob-uid', 'get_list', { listId: 'reading' });
    assert.equal(answer.result?.isError, true);
    assert.deepEqual(structured(answer), { code: 'NOT_FOUND' });
    assert.deepEqual(reads, ['users/bob-uid/lists/reading'], "only the token's account is read");
    // A valid token for bob with alice's name in a header or the URL is still bob.
    const headers = { ...await bearer('bob-uid'), 'x-papertok-uid': 'alice-uid', 'x-firebase-uid': 'alice-uid' };
    const request = new Request('https://papertok-report-api.example/mcp?uid=alice-uid', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.7', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_my_lists', arguments: {}, uid: 'alice-uid' } }),
    });
    const lists = await (await reportApi.fetch(request, env)).json<RpcAnswer>();
    assert.deepEqual(structured(lists), { lists: [BOBS_OWN] });
    assert.ok(reads.every(path => path.startsWith('users/bob-uid/')));
  });
});

test('list_my_feeds returns the custom feeds as the app reads them, each with the address of its page', async () => {
  await withStore({
    'users/alice-uid/settings/customFeeds': {
      updatedAt: new Date('2026-11-01T09:00:00.000Z'),
      feeds: [
        {
          id: 'feedabcd1', name: ' Graphene ', order: 'newest',
          ingredients: [
            { kind: 'category', id: 'cond-mat.mes-hall' },
            { kind: 'author', id: 'https://openalex.org/A5001', label: 'Ana Pérez' },
            { kind: 'keyword', query: '  Twisted  Bilayer ' },
            { kind: 'category', id: 'not-a-category' },
          ],
        },
        // Not a feed the app would show: its id is malformed.
        { id: 'BAD', name: 'Broken', order: 'newest', ingredients: [] },
        { id: 'feedwxyz2', name: 'Best of physics', order: 'best', ingredients: [{ kind: 'area', id: 'physics' }] },
      ],
    },
  }, async reads => {
    const env = accountEnv();
    const { answer } = await callAs(env, 'alice-uid', 'list_my_feeds', {});
    assert.equal(answer.result?.isError, undefined);
    assert.deepEqual(structured(answer), {
      feeds: [
        {
          id: 'feedabcd1', name: 'Graphene', order: 'newest',
          ingredients: [
            { kind: 'category', id: 'cond-mat.mes-hall' },
            { kind: 'author', id: 'A5001', label: 'Ana Pérez' },
            { kind: 'keyword', query: 'twisted bilayer' },
          ],
          url: 'https://papertok.app/feeds/feedabcd1',
        },
        { id: 'feedwxyz2', name: 'Best of physics', order: 'best', ingredients: [{ kind: 'area', id: 'physics' }], url: 'https://papertok.app/feeds/feedwxyz2' },
      ],
    });
    assert.deepEqual(reads, ['users/alice-uid/settings/customFeeds']);
    // An account that never made a feed has no such document.
    assert.deepEqual(structured((await callAs(env, 'bob-uid', 'list_my_feeds', {})).answer), { feeds: [] });
  });
});

const OWN_DATA_CALLS = [['list_my_lists', {}], ['get_list', { listId: 'reading' }], ['list_my_feeds', {}]] as const;

test('without the Firestore service account the account-data tools say so, and the others still answer', async () => {
  const lines = await mcpLines(() => withUpstream(url => {
    if (url.startsWith(S2_RECOMMENDATIONS)) return Response.json({ recommendedPapers: [recommended(1)] });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    const unconfigured = () => accountEnv({ FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: undefined });
    for (const [name, args] of OWN_DATA_CALLS) {
      const { response, answer } = await callAs(unconfigured(), 'alice-uid', name, args);
      assert.equal(response.status, 200, name);
      assert.equal(answer.result?.isError, true, name);
      assert.deepEqual(structured(answer), { code: 'ACCOUNT_DATA_NOT_CONFIGURED' }, name);
    }
    assert.deepEqual(calls, []);
    assert.equal((await callAs(unconfigured(), 'alice-uid', 'find_similar_papers', { id: '10.1234/example.2026.1' })).answer.result?.isError, undefined);
  }));
  assert.deepEqual(lines, OWN_DATA_CALLS.map(([tool]) => ({ route: '/mcp', tool, code: 'ACCOUNT_DATA_NOT_CONFIGURED', status: 503 })));
});

test('a Firestore failure is a tool error to retry, not an empty account', async () => {
  const lines = await mcpLines(() => withUpstream(url => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'service-token', expires_in: 3600 });
    if (url.startsWith('https://firestore.googleapis.com/')) return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    for (const [name, args] of OWN_DATA_CALLS) {
      const { answer } = await callAs(accountEnv(), 'alice-uid', name, args);
      assert.equal(answer.result?.isError, true, name);
      assert.deepEqual(structured(answer), { code: 'UPSTREAM_UNAVAILABLE' }, name);
    }
  }));
  assert.deepEqual(lines, OWN_DATA_CALLS.map(([tool]) => ({ route: '/mcp', tool, code: 'UPSTREAM_UNAVAILABLE', status: 503 })));
});

test("an account's lists and feeds are read from Firestore on every call and never stored at the edge", async () => {
  await withStore(ALICE_LIBRARY, async reads => {
    const cache = (globalThis as TestGlobals).caches!.default;
    const touched: string[] = [];
    const { match, put } = cache;
    cache.match = async request => { touched.push(String(request instanceof Request ? request.url : request)); return match(request); };
    cache.put = async (request, response) => { touched.push(String(request instanceof Request ? request.url : request)); return put(request, response); };
    const env = accountEnv();
    for (let round = 0; round < 2; round += 1) {
      for (const [name, args] of OWN_DATA_CALLS) assert.equal((await callAs(env, 'alice-uid', name, args)).answer.result?.isError, undefined, name);
    }
    assert.deepEqual(touched, []);
    assert.equal(reads.filter(path => path === 'users/alice-uid/lists/reading').length, 2);
  });
});

// ─── Account write tools (ENG-91, phase 2b) ───

const WRITE_SCOPES: Scopes = ['account:read', 'lists:write', 'feeds:write'];
const WRITE_TOOLS = ['add_papers_to_list', 'create_feed', 'create_list'];
// The keys `firestore.rules` accepts in the documents a write tool makes. The
// owner's app updates those documents under the rules, which refuse an update
// of a document that holds any other key. Stated here, not read from the rules.
const LIST_KEYS = ['id', 'name', 'emoji', 'color', 'paperIds', 'createdAt', 'publicShareId', 'onProfile', 'updatedAt', 'publicSyncedAt'];
const SAVED_PAPER_KEYS = [
  'title', 'authors', 'primaryCategory', 'categories', 'primaryTopic', 'classificationVersion', 'published', 'arxivId',
  'summary', 'abstractSource', 'doi', 'landingPageUrl', 'savedAt', 'acceptedConference', 'corpusUpdatedAt',
];
const NOON = '2026-10-24T12:00:00.000Z';
const FEEDS_PATH = 'users/alice-uid/settings/customFeeds';

// OpenAlex's names for the topics, authors, journal and concept the tests name (synthetic).
const OPENALEX_NAMES: Record<string, string> = {
  'topics/T10001': 'Graphene and two-dimensional materials',
  'topics/T10002': 'Strain engineering',
  'topics/T10003': 'Carbon nanotubes',
  'topics/T10004': 'Thin films',
  'authors/A5001': 'Ana Pérez',
  'authors/A5002': 'Luis Gómez',
  'authors/A5003': 'Rosa Díaz',
  'authors/A5004': 'Mei Chen',
  'sources/S3001': 'Journal of Sheets',
  'concepts/C2001': 'Condensed matter physics',
};
const namedEntity = (path: string) => ({ id: `https://openalex.org/${path.split('/')[1]}`, display_name: OPENALEX_NAMES[path] });
// OPENALEX_WORK with the topics and authors OpenAlex gives it. Its primary topic is its second.
const CLASSIFIED_WORK = {
  ...OPENALEX_WORK,
  primary_topic: namedEntity('topics/T10002'),
  topics: ['T10001', 'T10002', 'T10003', 'T10004'].map(id => namedEntity(`topics/${id}`)),
  authorships: ['A5001', 'A5002', 'A5003', 'A5004'].map(id => ({ author: namedEntity(`authors/${id}`), institutions: [] })),
};
const numberedWork = (id: string) => ({
  ...OPENALEX_WORK, id: `https://openalex.org/${id}`, doi: null, ids: { openalex: `https://openalex.org/${id}` }, title: `Paper ${id.slice(1)}`, primary_location: null,
});

// The providers: OpenAlex holds OPENALEX_WORK by id and by DOI, a work
// "Paper <n>" for every W1 to W8999 and the entities above, and arXiv holds 2603.01234.
const providers: Upstream = url => {
  if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(url.includes('id_list=2603.01234') ? ARXIV_LAB_ENTRY : ''));
  // A list of works: OpenAlex's record of an arXiv preprint, which it has none of here.
  if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [] });
  const asked = /^https:\/\/api\.openalex\.org\/(\w+)\/([^?]+)/.exec(url);
  if (!asked) throw new Error(`unexpected upstream ${url}`);
  const [, collection, id] = asked;
  if (collection === 'works' && (id === 'W4400000001' || decodeURIComponent(id) === 'doi:10.1234/example.2026.1')) return Response.json(CLASSIFIED_WORK);
  if (collection === 'works' && /^W\d+$/.test(id) && Number(id.slice(1)) < 9000) return Response.json(numberedWork(id));
  if (OPENALEX_NAMES[`${collection}/${id}`]) return Response.json(namedEntity(`${collection}/${id}`));
  return Response.json({ error: 'Not found' }, { status: 404 });
};

type Store = ReturnType<typeof fakeFirestore>;
const withWrites = (documents: Record<string, object>, run: (store: Store, calls: string[]) => Promise<void>, upstream: Upstream = providers) => {
  const store = fakeFirestore(documents);
  return withUpstream((url, init) => store.answer(url, init) ?? upstream(url, init), calls => run(store, calls));
};
const providerCalls = (calls: string[]) => calls.filter(url => !url.startsWith('https://firestore.googleapis.com/') && !url.startsWith('https://oauth2.googleapis.com/'));
const writeAs = (env: WorkerEnv, uid: string, name: string, args: unknown) => callAs(env, uid, name, args, undefined, WRITE_SCOPES);
const minutesLater = (minutes: number) => { pinnedClock?.mock.mockImplementation(() => EVEN_ARXIV_PERIOD + minutes * 60_000); };
const secondsToMidnight = (minutes: number) => 12 * 60 * 60 - minutes * 60;
const works = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `W${from + index}`);

test('a write tool is a tool only to a token that carries its scope', async () => {
  await withWrites({}, async (store, calls) => {
    const ledger = inMemoryQuotaLedger();
    const env = accountEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
    const listedFor = async (scopes: Scopes) => {
      const { answer } = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers: await bearer('alice-uid', undefined, scopes) });
      return (answer.result?.tools || []).map(tool => tool.name).filter(name => WRITE_TOOLS.includes(name)).sort();
    };
    assert.deepEqual(await listedFor(['account:read']), []);
    assert.deepEqual(await listedFor(['lists:write']), ['add_papers_to_list', 'create_list']);
    assert.deepEqual(await listedFor(['account:read', 'feeds:write']), ['create_feed']);
    assert.deepEqual(await listedFor(WRITE_SCOPES), WRITE_TOOLS);
    // A valid token without the tool's scope is answered as a name that is no tool.
    const unknown = await callAs(env, 'alice-uid', 'delete_everything', {});
    for (const [scopes, name, args] of [
      [['account:read'], 'create_list', { name: 'Reading' }],
      [['account:read'], 'add_papers_to_list', { listId: 'thesis', paperIds: ['W1'] }],
      [['account:read'], 'create_feed', { name: 'Graphene', fromPaperId: 'W4400000001' }],
      [['account:read', 'feeds:write'], 'create_list', { name: 'Reading' }],
      [['account:read', 'feeds:write'], 'add_papers_to_list', { listId: 'thesis', paperIds: ['W1'] }],
      [['account:read', 'lists:write'], 'create_feed', { name: 'Graphene', fromPaperId: 'W4400000001' }],
      [['lists:write'], 'list_my_lists', {}],
    ] as const) {
      const { response, answer } = await callAs(env, 'alice-uid', name, args, undefined, [...scopes]);
      assert.equal(response.status, 200, name);
      assert.deepEqual(answer, unknown.answer, `${name} with ${scopes.join(' ')}`);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(ledger.calls, [], 'nothing is reserved for a tool the caller does not have');
    assert.deepEqual(store.commits, []);
  });
});

test('the write tools say what they write, and a connection that has them is told so', async () => {
  await withUpstream(NO_UPSTREAM, async () => {
    const env = accountEnv();
    const headers = await bearer('alice-uid', undefined, WRITE_SCOPES);
    const { answer } = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers });
    const tools = (answer.result?.tools || []).filter(tool => WRITE_TOOLS.includes(tool.name));
    const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    assert.deepEqual(tools.map(tool => [tool.name, tool.annotations]), [
      ['create_list', { ...writes, idempotentHint: false }],
      // The same papers added again change nothing.
      ['add_papers_to_list', { ...writes, idempotentHint: true }],
      ['create_feed', { ...writes, idempotentHint: false }],
    ]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.ok(tool.description.includes('private'), tool.name);
      assert.ok(tool.description.includes('"notAdded"'), tool.name);
    }
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } };
    const told = async (scopes?: Scopes) => {
      const { answer: initialized } = await rpc(env, initialize, scopes ? { headers: await bearer('alice-uid', undefined, scopes) } : undefined);
      return initialized.result as { instructions: string; serverInfo: { version: string } };
    };
    // A request without a token is told what it was told before there were account tools.
    const anonymous = (await told()).instructions;
    assert.equal(anonymous, 'Read-only access to scholarly papers as PaperTok normalizes them. Results carry abstracts and metadata, never full text. citationCount is given only where citationCountKnown is true. A field a paper lacks, such as its abstract, review status or open-access status, is unknown, not empty, zero or false.');
    const papers = anonymous.slice(anonymous.indexOf('Results carry'));
    // A token that only reads is still told it is read-only, and nothing about writing.
    const reader = (await told(['account:read'])).instructions;
    assert.ok(reader.startsWith(`${anonymous} `));
    assert.ok(!reader.includes('write tools'));
    // A token that writes is not told it is read-only.
    const writer = await told(WRITE_SCOPES);
    assert.ok(!writer.instructions.includes('Read-only'));
    assert.ok(writer.instructions.includes(papers), 'what a paper result means is told whatever the scopes');
    assert.ok(writer.instructions.includes(reader.slice(anonymous.length)), 'the reading tools are told as to a reader');
    assert.ok(writer.instructions.includes('publish and delete nothing'));
    assert.equal(writer.serverInfo.version, '1.2.0');
    // A token that writes lists and reads nothing is told of no tool it lacks.
    const listWriter = (await told(['lists:write'])).instructions;
    assert.ok(!listWriter.includes('Read-only'));
    assert.ok(listWriter.includes('signed in to one PaperTok account'));
    assert.ok(listWriter.includes('publish and delete nothing'));
    for (const name of ACCOUNT_TOOLS) assert.ok(!listWriter.includes(name), name);
  });
});

test('create_list makes a private list as the app makes one, with a saved copy of each paper', async () => {
  await withWrites({
    // A copy the reader saved themselves.
    'users/alice-uid/savedPapers/openalex:W77': { title: "The reader's own copy", savedAt: new Date('2026-09-03T08:00:00.000Z') },
  }, async store => {
    const { answer } = await writeAs(accountEnv(), 'alice-uid', 'create_list', {
      name: '  Strained\n graphene ',
      paperIds: ['https://doi.org/10.1234/example.2026.1', 'arXiv:2603.01234v2', 'W77', 'W9999', 'not an id', 'https://openalex.org/W77'],
    });
    assert.equal(answer.result?.isError, undefined);
    const result = structured<{ list: { id: string } }>(answer);
    const { id } = result.list;
    assert.match(id, /^list_[0-9a-f]{24}$/);
    assert.deepEqual(result, {
      list: { id, name: 'Strained graphene', paperCount: 3, public: false, url: `https://papertok.app/lists/${id}` },
      added: [
        { id: 'openalex:W4400000001', title: 'Graphene sheets under strain' },
        { id: '2603.01234', title: 'Strained graphene in the lab' },
        { id: 'openalex:W77', title: 'Paper 77' },
      ],
      notAdded: [
        { id: 'not an id', code: 'INVALID_ID' },
        { id: 'https://openalex.org/W77', code: 'DUPLICATE' },
        { id: 'W9999', code: 'NOT_FOUND' },
      ],
    });

    assert.equal(store.commits.length, 1, 'the list and the copies land in one commit');
    const [list, ...copies] = store.commits[0];
    assert.equal(list.update?.name, `${FIRESTORE_ROOT}/users/alice-uid/lists/${id}`);
    assert.deepEqual(list.currentDocument, { exists: false });
    assert.equal(list.updateMask, undefined);
    // `createdAt` is the string the app writes, and `updatedAt` the timestamp the rules require.
    assert.deepEqual(list.update?.fields, {
      id: { stringValue: id },
      name: { stringValue: 'Strained graphene' },
      emoji: { stringValue: 'Folder' },
      paperIds: { arrayValue: { values: [{ stringValue: 'openalex:W4400000001' }, { stringValue: '2603.01234' }, { stringValue: 'openalex:W77' }] } },
      createdAt: { stringValue: NOON },
      updatedAt: { timestampValue: NOON },
    });
    for (const key of Object.keys(list.update.fields)) assert.ok(LIST_KEYS.includes(key), key);

    // The copy the reader already held is not written again.
    assert.deepEqual(copies.map(copy => copy.update?.name), [
      `${FIRESTORE_ROOT}/users/alice-uid/savedPapers/openalex:W4400000001`,
      `${FIRESTORE_ROOT}/users/alice-uid/savedPapers/2603.01234`,
    ]);
    for (const copy of copies) {
      assert.equal(copy.currentDocument, undefined);
      assert.deepEqual(copy.updateMask?.fieldPaths, Object.keys(copy.update!.fields));
      for (const key of Object.keys(copy.update!.fields)) assert.ok(SAVED_PAPER_KEYS.includes(key), key);
    }
    // The documents the rules suite checks the owner can still change
    // (test-support/mcp-written-documents.ts). The OpenAlex copy has no
    // `summary`: the fixture's three-word abstract is none the app keeps.
    assert.deepEqual(store.documents[`users/alice-uid/lists/${id}`], writtenList(id));
    assert.deepEqual(store.documents['users/alice-uid/savedPapers/openalex:W4400000001'], WRITTEN_OPENALEX_COPY);
    assert.deepEqual(store.documents['users/alice-uid/savedPapers/2603.01234'], WRITTEN_ARXIV_COPY);
    assert.deepEqual(copies[0].update?.fields.classificationVersion, { integerValue: '1' });
    assert.deepEqual(store.documents['users/alice-uid/savedPapers/openalex:W77'], { title: "The reader's own copy", savedAt: new Date('2026-09-03T08:00:00.000Z') });
    // Nothing else is written: no interaction record, and nothing public.
    assert.deepEqual(Object.keys(store.documents).sort(), [
      `users/alice-uid/lists/${id}`,
      'users/alice-uid/savedPapers/2603.01234',
      'users/alice-uid/savedPapers/openalex:W4400000001',
      'users/alice-uid/savedPapers/openalex:W77',
    ]);

    // An empty list is a list too, and a DOI's slash is escaped in its copy's name.
    const empty = structured<{ list: { id: string; paperCount: number }; added: unknown[]; notAdded: unknown[] }>(
      (await writeAs(accountEnv(), 'bob-uid', 'create_list', { name: 'To read' })).answer,
    );
    assert.deepEqual([empty.list.paperCount, empty.added, empty.notAdded], [0, [], []]);
    assert.deepEqual(store.documents[`users/bob-uid/lists/${empty.list.id}`], { id: empty.list.id, name: 'To read', emoji: 'Folder', paperIds: [], createdAt: NOON, updatedAt: new Date(NOON) });
  });
});

// OpenAlex's record of the arXiv preprint 2603.01234, with the subjects OpenAlex gives it.
const CLASSIFIED_PREPRINT = { ...OPENALEX_LAB_PREPRINT, primary_topic: CLASSIFIED_WORK.primary_topic, topics: CLASSIFIED_WORK.topics };

test('a paper asked for by arXiv id is filed under that id when OpenAlex answers for arXiv, without arXiv categories OpenAlex does not give', async () => {
  await withWrites({}, async store => {
    const { answer } = await writeAs(accountEnv(), 'alice-uid', 'create_list', { name: 'Lab', paperIds: ['2603.01234'] });
    const { list, added } = structured<{ list: { id: string }; added: unknown[] }>(answer);
    assert.deepEqual(added, [{ id: '2603.01234', title: 'Strained graphene in the lab' }]);
    assert.deepEqual((store.documents[`users/alice-uid/lists/${list.id}`] as { paperIds: string[] }).paperIds, ['2603.01234']);
    // OpenAlex's topic names are not the preprint's arXiv categories: those
    // stay unknown, as the app stores an unknown classification, and
    // OpenAlex's primary topic is kept.
    assert.deepEqual(store.documents['users/alice-uid/savedPapers/2603.01234'], WRITTEN_FALLBACK_COPY);
    assert.equal(Object.keys(store.documents).some(path => path.includes('openalex:')), false, 'no second copy under the OpenAlex id');
  }, url => {
    // arXiv's pacing refuses the lookup, so the tool asks OpenAlex for the work at arXiv's landing page.
    if (url.startsWith('https://export.arxiv.org/')) return new Response('Rate exceeded.', { status: 429, headers: { 'retry-after': '30' } });
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [CLASSIFIED_PREPRINT] });
    throw new Error(`unexpected upstream ${url}`);
  });
});

test("a copy filed under an arXiv id keeps arXiv's own categories when a search has just read them", async () => {
  await withWrites({}, async store => {
    const env = accountEnv();
    // The search takes arXiv's seat and leaves the preprint's categories at the edge.
    const searched = await writeAs(env, 'alice-uid', 'search_papers', { query: 'strained graphene' });
    assert.equal(searched.answer.result?.isError, undefined);
    // The lookup that follows finds the seat taken, and OpenAlex answers.
    const { answer } = await writeAs(env, 'alice-uid', 'create_list', { name: 'Lab', paperIds: ['2603.01234'] });
    assert.deepEqual(structured<{ added: unknown[] }>(answer).added, [{ id: '2603.01234', title: 'Strained graphene in the lab' }]);
    assert.deepEqual(store.documents['users/alice-uid/savedPapers/2603.01234'], {
      ...WRITTEN_FALLBACK_COPY, primaryCategory: 'cond-mat.mes-hall', categories: ['cond-mat.mes-hall'],
    });
  }, url => {
    if (url.startsWith('https://export.arxiv.org/')) return new Response(arxivFeed(ARXIV_LAB_ENTRY));
    if (url.startsWith('https://api.openalex.org/works?') && url.includes('search=')) return Response.json({ results: [] });
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [CLASSIFIED_PREPRINT] });
    throw new Error(`unexpected upstream ${url}`);
  });
});

const manyCategories = (count: number) => Array.from({ length: count }, (_, index) => (index === 0 ? 'cond-mat.mes-hall' : `cond-mat.test-${index}`));
const categorizedEntry = (arxivId: string, categories: string[]) => `
  <entry>
    <id>http://arxiv.org/abs/${arxivId}v1</id>
    <published>2026-03-01T10:00:00Z</published>
    <updated>2026-03-01T10:00:00Z</updated>
    <title>A paper of many categories</title>
    <summary>It is filed widely.</summary>
    <author><name>Luis Gómez</name></author>
    <arxiv:primary_category term="${categories[0]}"/>
    ${categories.map(category => `<category term="${category}"/>`).join('')}
  </entry>`;

test("a saved copy keeps every category of its paper, up to the app's own limit, though a result shows five", async () => {
  const seven = manyCategories(7);
  const twentyFive = manyCategories(25);
  await withWrites({}, async store => {
    const env = accountEnv();
    const shown = structured<{ paper: { categories: string[]; omitted?: Record<string, number> } }>((await writeAs(env, 'alice-uid', 'get_paper', { id: '2603.00007' })).answer);
    assert.deepEqual([shown.paper.categories, shown.paper.omitted?.categories], [seven.slice(0, 5), 2], 'get_paper still cuts what it returns');
    minutesLater(1);
    assert.equal((await writeAs(env, 'alice-uid', 'create_list', { name: 'Seven', paperIds: ['2603.00007'] })).answer.result?.isError, undefined);
    const copy = store.documents['users/alice-uid/savedPapers/2603.00007'] as { primaryCategory: string; categories: string[]; classificationVersion: number };
    assert.deepEqual(copy.categories, seven);
    assert.equal(copy.primaryCategory, seven[0]);
    // What the app's own save keeps of the same paper.
    assert.deepEqual(
      { primaryCategory: copy.primaryCategory, categories: copy.categories, classificationVersion: copy.classificationVersion },
      storedClassification({ primaryCategory: seven[0], categories: seven }),
    );
    minutesLater(2);
    assert.equal((await writeAs(env, 'alice-uid', 'create_list', { name: 'Twenty-five', paperIds: ['2603.00025'] })).answer.result?.isError, undefined);
    const capped = store.documents['users/alice-uid/savedPapers/2603.00025'] as { categories: string[] };
    const kept = storedClassification({ primaryCategory: twentyFive[0], categories: twentyFive }).categories;
    assert.ok(kept.length > 5 && kept.length < twentyFive.length, 'the app keeps more than a result shows, and not all twenty-five');
    assert.deepEqual(capped.categories, kept);
  }, url => {
    if (url.includes('id_list=2603.00007')) return new Response(arxivFeed(categorizedEntry('2603.00007', seven)));
    if (url.includes('id_list=2603.00025')) return new Response(arxivFeed(categorizedEntry('2603.00025', twentyFive)));
    throw new Error(`unexpected upstream ${url}`);
  });
});

test('create_list made again with its requestId returns the list it made', async () => {
  await withWrites({}, async (store, calls) => {
    const env = accountEnv();
    const args = { name: 'Reading', paperIds: ['W77'], requestId: 'retry-0001' };
    const first = structured<{ list: { id: string } }>((await writeAs(env, 'alice-uid', 'create_list', args)).answer);
    const asked = providerCalls(calls).length;
    const again = await writeAs(env, 'alice-uid', 'create_list', args);
    assert.equal(again.answer.result?.isError, undefined);
    assert.deepEqual(structured(again.answer), {
      list: { id: first.list.id, name: 'Reading', paperCount: 1, public: false, updatedAt: NOON, url: `https://papertok.app/lists/${first.list.id}` },
      existing: true,
    });
    assert.equal(store.commits.length, 1);
    assert.equal(providerCalls(calls).length, asked, 'a call made again looks nothing up');
    // The first call with a requestId wins. A later call that reuses it for
    // another name and other papers gets the first list back, marked as
    // existing, with its own name and count to compare; nothing changes.
    const reused = await writeAs(env, 'alice-uid', 'create_list', { name: 'Something else', paperIds: ['W78', 'W79'], requestId: 'retry-0001' });
    assert.equal(reused.answer.result?.isError, undefined);
    assert.deepEqual(structured(reused.answer), structured(again.answer));
    assert.equal(store.commits.length, 1);
    assert.equal(providerCalls(calls).length, asked);
    assert.deepEqual(store.documents[`users/alice-uid/lists/${first.list.id}`], {
      id: first.list.id, name: 'Reading', emoji: 'Folder', paperIds: ['openalex:W77'], createdAt: NOON, updatedAt: new Date(NOON),
    });
    const described = (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers: await bearer('alice-uid', undefined, WRITE_SCOPES) })).answer.result?.tools || [];
    for (const name of ['create_list', 'create_feed']) {
      assert.ok(described.find(tool => tool.name === name)?.description.includes('The first call with a requestId wins'), name);
    }
    // Another requestId, no requestId and another account each make their own list.
    const ids = [first.list.id];
    for (const [uid, requestId] of [['alice-uid', 'retry-0002'], ['alice-uid', undefined], ['alice-uid', undefined], ['bob-uid', 'retry-0001']] as const) {
      ids.push(structured<{ list: { id: string } }>((await writeAs(env, uid, 'create_list', { name: 'Reading', requestId })).answer).list.id);
    }
    assert.equal(new Set(ids).size, 5);
    assert.equal(store.commits.length, 5);

    // The first attempt lands while its retry is looking papers up: the retry finds the list made.
    store.hooks.beforeCommit = ([list]) => store.write(list.update!.name.slice(FIRESTORE_ROOT.length + 1), { id: 'x', name: 'Raced', emoji: 'Folder', paperIds: ['openalex:W5'] });
    const raced = structured<{ list: { name: string; paperCount: number }; existing?: boolean }>(
      (await writeAs(env, 'alice-uid', 'create_list', { name: 'Raced', paperIds: ['W5'], requestId: 'retry-0003' })).answer,
    );
    assert.deepEqual([raced.list.name, raced.list.paperCount, raced.existing], ['Raced', 1, true]);
    assert.equal(store.commits.length, 5);
  });
});

test('arguments a write tool cannot read are refused before anything is reserved, read or written', async () => {
  await withWrites(ALICE_LIBRARY, async (store, calls) => {
    const ledger = inMemoryQuotaLedger();
    const env = accountEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
    const area = { kind: 'area', id: 'physics' };
    for (const [name, args] of [
      ['create_list', {}],
      ['create_list', { name: '' }],
      ['create_list', { name: ' \n ' }],
      ['create_list', { name: 'x'.repeat(81) }],
      ['create_list', { name: 7 }],
      ['create_list', { name: 'Reading', paperIds: 'W1' }],
      ['create_list', { name: 'Reading', paperIds: works(1, 26) }],
      ['create_list', { name: 'Reading', paperIds: [7] }],
      ['create_list', { name: 'Reading', paperIds: [''] }],
      ['create_list', { name: 'Reading', paperIds: ['x'.repeat(301)] }],
      ['create_list', { name: 'Reading', requestId: 'short' }],
      ['create_list', { name: 'Reading', requestId: 'has a space' }],
      ['create_list', { name: 'Reading', requestId: 'x'.repeat(65) }],
      ['create_list', { name: 'Reading', requestId: 12345678 }],
      // A list is private, the account is the token's, and the app's defaults are not the caller's to set.
      ['create_list', { name: 'Reading', public: true }],
      ['create_list', { name: 'Reading', publicShareId: SHARE_ID }],
      ['create_list', { name: 'Reading', uid: 'bob-uid' }],
      ['create_list', { name: 'Reading', emoji: 'Fire' }],
      ['add_papers_to_list', { listId: 'thesis' }],
      ['add_papers_to_list', { listId: 'thesis', paperIds: [] }],
      ['add_papers_to_list', { listId: 'thesis', paperIds: works(1, 26) }],
      ['add_papers_to_list', { paperIds: ['W1'] }],
      ['add_papers_to_list', { listId: '..', paperIds: ['W1'] }],
      ['add_papers_to_list', { listId: '../../bob-uid/lists/private', paperIds: ['W1'] }],
      ['add_papers_to_list', { listId: '__thesis__', paperIds: ['W1'] }],
      ['add_papers_to_list', { listId: 'thesis', paperIds: ['W1'], uid: 'bob-uid' }],
      ['create_feed', {}],
      ['create_feed', { name: 'Graphene' }],
      ['create_feed', { name: 'Graphene', fromPaperId: 'W1', ingredients: [area] }],
      ['create_feed', { name: '', fromPaperId: 'W1' }],
      ['create_feed', { name: 'x'.repeat(33), fromPaperId: 'W1' }],
      ['create_feed', { name: 'Graphene', fromPaperId: 'not an id' }],
      ['create_feed', { name: 'Graphene', fromPaperId: 'W1', order: 'oldest' }],
      ['create_feed', { name: 'Graphene', fromPaperId: 'W1', include: [] }],
      ['create_feed', { name: 'Graphene', fromPaperId: 'W1', include: ['keywords'] }],
      ['create_feed', { name: 'Graphene', fromPaperId: 'W1', include: ['topics', 'topics'] }],
      ['create_feed', { name: 'Graphene', ingredients: [] }],
      ['create_feed', { name: 'Graphene', ingredients: 'physics' }],
      ['create_feed', { name: 'Graphene', ingredients: Array(21).fill(area) }],
      ['create_feed', { name: 'Graphene', ingredients: [area], include: ['topics'] }],
      ['create_feed', { name: 'Graphene', ingredients: [area], requestId: 'no' }],
      ['create_feed', { name: 'Graphene', ingredients: [area], id: 'feedabcd1' }],
    ] as const) {
      const { answer } = await writeAs(env, 'alice-uid', name, args);
      assert.equal(answer.result?.isError, true, `${name} ${JSON.stringify(args).slice(0, 80)}`);
      assert.equal(structured<{ code: string }>(answer).code, 'INVALID_ARGUMENTS', `${name} ${JSON.stringify(args).slice(0, 80)}`);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(ledger.calls, []);
    assert.deepEqual(store.commits, []);
  });
});

test("an account's agents create twenty lists a UTC day, and a call that creates nothing spends none of them", async () => {
  await withWrites({}, async store => {
    const env = accountEnv();
    // Papers were asked for and none was found: nothing is created.
    for (let call = 0; call < 3; call += 1) {
      minutesLater(call);
      const { answer } = await writeAs(env, 'alice-uid', 'create_list', { name: `Nothing ${call}`, paperIds: ['W9999', 'no such id'] });
      assert.equal(answer.result?.isError, true);
      assert.deepEqual(structured(answer), { code: 'NO_PAPERS_ADDED', notAdded: [{ id: 'no such id', code: 'INVALID_ID' }, { id: 'W9999', code: 'NOT_FOUND' }] });
    }
    assert.deepEqual(store.commits, []);
    for (let made = 0; made < 20; made += 1) {
      minutesLater(3 + made);
      assert.equal((await writeAs(env, 'alice-uid', 'create_list', { name: `List ${made + 1}`, paperIds: ['W1'] })).answer.result?.isError, undefined, `list ${made + 1}`);
    }
    minutesLater(23);
    const refused = await writeAs(env, 'alice-uid', 'create_list', { name: 'List 21' });
    assert.equal(refused.answer.result?.isError, true);
    assert.deepEqual(structured(refused.answer), { code: 'LISTS_DAILY_LIMIT', limit: 20, remaining: 0, retryAfterSeconds: secondsToMidnight(23) });
    assert.equal(store.commits.length, 20);
    // Another account has its own day, and the next UTC day is a new one.
    assert.equal((await writeAs(env, 'bob-uid', 'create_list', { name: 'List 1' })).answer.result?.isError, undefined);
    minutesLater(12 * 60);
    assert.equal((await writeAs(env, 'alice-uid', 'create_list', { name: 'List 21' })).answer.result?.isError, undefined);
  });
});

const NOTES = { id: 'notes', name: 'Notes', emoji: 'Folder', color: 'teal', paperIds: ['2603.01234'], createdAt: '2026-09-02T08:00:00.000Z' };
const NOTES_PATH = 'users/alice-uid/lists/notes';
const NOTES_URL = 'https://papertok.app/lists/notes';

test('add_papers_to_list appends to a private list of the account and saves the copies', async () => {
  await withWrites({ [NOTES_PATH]: NOTES }, async store => {
    const env = accountEnv();
    const args = { listId: 'notes', paperIds: ['W77', '2603.01234', 'W9999', 'W78'] };
    const { answer } = await writeAs(env, 'alice-uid', 'add_papers_to_list', args);
    assert.equal(answer.result?.isError, undefined);
    assert.deepEqual(structured(answer), {
      list: { id: 'notes', name: 'Notes', paperCount: 3, public: false, url: NOTES_URL },
      added: [{ id: 'openalex:W77', title: 'Paper 77' }, { id: 'openalex:W78', title: 'Paper 78' }],
      notAdded: [{ id: 'W9999', code: 'NOT_FOUND' }, { id: '2603.01234', code: 'ALREADY_IN_LIST' }],
    });
    assert.equal(store.commits.length, 1);
    const [list, ...copies] = store.commits[0];
    assert.equal(list.update?.name, `${FIRESTORE_ROOT}/${NOTES_PATH}`);
    // Only the two fields the app's own save touches, and only on the version read.
    assert.deepEqual(list.updateMask, { fieldPaths: ['paperIds', 'updatedAt'] });
    assert.deepEqual(list.currentDocument, { updateTime: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(list.update?.fields, {
      paperIds: { arrayValue: { values: [{ stringValue: '2603.01234' }, { stringValue: 'openalex:W77' }, { stringValue: 'openalex:W78' }] } },
      updatedAt: { timestampValue: NOON },
    });
    assert.deepEqual(store.documents[NOTES_PATH], { ...NOTES, paperIds: ['2603.01234', 'openalex:W77', 'openalex:W78'], updatedAt: new Date(NOON) });
    for (const key of Object.keys(store.documents[NOTES_PATH])) assert.ok(LIST_KEYS.includes(key), key);
    // The paper already in the list gets no copy from here.
    assert.deepEqual(copies.map(copy => copy.update?.name), ['openalex:W77', 'openalex:W78'].map(id => `${FIRESTORE_ROOT}/users/alice-uid/savedPapers/${id}`));

    // The same call again adds nothing, writes nothing and is no error.
    minutesLater(1);
    const again =await writeAs(env, 'alice-uid', 'add_papers_to_list', args);
    assert.equal(again.answer.result?.isError, undefined);
    assert.deepEqual(structured(again.answer), {
      list: { id: 'notes', name: 'Notes', paperCount: 3, public: false, url: NOTES_URL },
      added: [],
      notAdded: [
        { id: 'W9999', code: 'NOT_FOUND' }, { id: 'W77', code: 'ALREADY_IN_LIST' },
        { id: '2603.01234', code: 'ALREADY_IN_LIST' }, { id: 'W78', code: 'ALREADY_IN_LIST' },
      ],
    });
    // Nothing found and nothing already there is an error.
    const nothing = await writeAs(env, 'alice-uid', 'add_papers_to_list', { listId: 'notes', paperIds: ['W9999', 'nonsense'] });
    assert.equal(nothing.answer.result?.isError, true);
    assert.deepEqual(structured(nothing.answer), { code: 'NO_PAPERS_ADDED', notAdded: [{ id: 'nonsense', code: 'INVALID_ID' }, { id: 'W9999', code: 'NOT_FOUND' }] });
    assert.equal(store.commits.length, 1);
  });
});

test("add_papers_to_list refuses a published list, and finds no list of another account", async () => {
  await withWrites(ALICE_LIBRARY, async (store, calls) => {
    const env = accountEnv();
    for (const [uid, listId, code] of [
      ['alice-uid', 'reading', 'LIST_IS_PUBLIC'],
      ['bob-uid', 'reading', 'NOT_FOUND'],
      ['bob-uid', 'thesis', 'NOT_FOUND'],
      ['alice-uid', 'private', 'NOT_FOUND'],
      ['alice-uid', 'no-such-list', 'NOT_FOUND'],
    ] as const) {
      const { answer } = await writeAs(env, uid, 'add_papers_to_list', { listId, paperIds: ['W77'] });
      assert.equal(answer.result?.isError, true, `${uid} ${listId}`);
      assert.deepEqual(structured(answer), { code }, `${uid} ${listId}`);
    }
    assert.deepEqual(store.reads, ['alice-uid/lists/reading', 'bob-uid/lists/reading', 'bob-uid/lists/thesis', 'alice-uid/lists/private', 'alice-uid/lists/no-such-list'].map(path => `users/${path}`));
    assert.deepEqual(providerCalls(calls), [], 'a refused list looks no paper up');
    assert.deepEqual(store.commits, []);
    assert.deepEqual(store.documents, ALICE_LIBRARY);
  });
});

test('add_papers_to_list never takes a list past five hundred papers', async () => {
  const held = Array.from({ length: 499 }, (_, index) => `2601.${String(index + 1).padStart(5, '0')}`);
  await withWrites({ [NOTES_PATH]: { ...NOTES, paperIds: held } }, async (store, calls) => {
    const env = accountEnv();
    const { answer } = await writeAs(env, 'alice-uid', 'add_papers_to_list', { listId: 'notes', paperIds: ['W1', 'W2', 'W3'] });
    assert.deepEqual(structured(answer), {
      list: { id: 'notes', name: 'Notes', paperCount: 500, public: false, url: NOTES_URL },
      added: [{ id: 'openalex:W1', title: 'Paper 1' }],
      notAdded: [{ id: 'W2', code: 'LIST_FULL' }, { id: 'W3', code: 'LIST_FULL' }],
    });
    assert.deepEqual((store.documents[NOTES_PATH] as typeof NOTES).paperIds, [...held, 'openalex:W1']);
    assert.equal(store.documents['users/alice-uid/savedPapers/openalex:W2'], undefined, 'a paper that did not fit gets no copy');
    const asked = providerCalls(calls).length;
    const full = await writeAs(env, 'alice-uid', 'add_papers_to_list', { listId: 'notes', paperIds: ['W4'] });
    assert.equal(full.answer.result?.isError, true);
    assert.deepEqual(structured(full.answer), { code: 'LIST_FULL', limit: 500 });
    assert.equal(providerCalls(calls).length, asked);
    assert.equal(store.commits.length, 1);
  });
});

test('add_papers_to_list reads the list again when it changed under the write, once', async () => {
  await withWrites({ [NOTES_PATH]: NOTES }, async store => {
    const env = accountEnv();
    // The reader saves W5 to the list from the app while the tool looks its papers up.
    store.hooks.beforeCommit = () => store.write(NOTES_PATH, { ...NOTES, name: 'Renamed', paperIds: ['2603.01234', 'openalex:W5'] });
    const { answer } = await writeAs(env, 'alice-uid', 'add_papers_to_list', { listId: 'notes', paperIds: ['W5', 'W6'] });
    assert.deepEqual(structured(answer), {
      list: { id: 'notes', name: 'Renamed', paperCount: 3, public: false, url: NOTES_URL },
      added: [{ id: 'openalex:W6', title: 'Paper 6' }],
      notAdded: [{ id: 'W5', code: 'ALREADY_IN_LIST' }],
    });
    assert.deepEqual(store.documents[NOTES_PATH], { ...NOTES, name: 'Renamed', paperIds: ['2603.01234', 'openalex:W5', 'openalex:W6'], updatedAt: new Date(NOON) });
    assert.equal(store.commits.length, 1);

    // The reader publishes the list meanwhile: the second reading refuses it.
    store.hooks.beforeCommit = () => store.write(NOTES_PATH, { ...store.documents[NOTES_PATH], publicShareId: SHARE_ID });
    const published = await writeAs(env, 'alice-uid', 'add_papers_to_list', { listId: 'notes', paperIds: ['W7'] });
    assert.deepEqual(structured(published.answer), { code: 'LIST_IS_PUBLIC' });

    // A list that changes under both attempts is left as it is.
    store.write(NOTES_PATH, NOTES);
    const touch = () => {
      store.write(NOTES_PATH, { ...store.documents[NOTES_PATH] });
      store.hooks.beforeCommit = touch;
    };
    store.hooks.beforeCommit = touch;
    const changed = await writeAs(env, 'alice-uid', 'add_papers_to_list', { listId: 'notes', paperIds: ['W8'] });
    store.hooks.beforeCommit = undefined;
    assert.equal(changed.answer.result?.isError, true);
    assert.deepEqual(structured(changed.answer), { code: 'LIST_CHANGED' });
    assert.deepEqual(store.documents[NOTES_PATH], NOTES);
    assert.equal(store.documents['users/alice-uid/savedPapers/openalex:W8'], undefined);
    assert.equal(store.commits.length, 1);
  });
});

test("an account's agents add two hundred papers a UTC day, and a call gives back what it did not add", async () => {
  await withWrites({ [NOTES_PATH]: { ...NOTES, paperIds: [] } }, async store => {
    const env = accountEnv();
    const add = async (minute: number, paperIds: string[]) => {
      minutesLater(minute);
      return (await writeAs(env, 'alice-uid', 'add_papers_to_list', { listId: 'notes', paperIds })).answer;
    };
    // Twenty-five asked for, one found: the day is charged one.
    const one = structured<{ added: unknown[] }>(await add(0, ['W1', ...works(9001, 9024)]));
    assert.equal(one.added.length, 1);
    for (let call = 0; call < 7; call += 1) {
      const result = structured<{ added: unknown[] }>(await add(1 + call, works(2 + call * 25, 26 + call * 25)));
      assert.equal(result.added.length, 25, `call ${call + 1}`);
    }
    // 176 added. Twenty-five more would pass the day's two hundred, so none is looked up or added.
    const over = await add(8, works(177, 201));
    assert.equal(over.result?.isError, true);
    assert.deepEqual(structured(over), { code: 'PAPERS_DAILY_LIMIT', limit: 200, remaining: 24, retryAfterSeconds: secondsToMidnight(8) });
    assert.equal(structured<{ added: unknown[] }>(await add(9, works(177, 200))).added.length, 24);
    assert.deepEqual(structured(await add(10, ['W201'])), { code: 'PAPERS_DAILY_LIMIT', limit: 200, remaining: 0, retryAfterSeconds: secondsToMidnight(10) });
    assert.equal((store.documents[NOTES_PATH] as typeof NOTES).paperIds.length, 200);
    // create_list draws on the same two hundred, and an empty list on none of them.
    minutesLater(11);
    assert.equal(structured<{ code: string }>((await writeAs(env, 'alice-uid', 'create_list', { name: 'More', paperIds: ['W202'] })).answer).code, 'PAPERS_DAILY_LIMIT');
    assert.equal((await writeAs(env, 'alice-uid', 'create_list', { name: 'Empty' })).answer.result?.isError, undefined);
  });
});

test('each paper a write tool looks up counts as a call of the account, so a call cannot ask for more than its minute', async () => {
  await withWrites({}, async (store, calls) => {
    const env = accountEnv();
    // One call and twenty-five lookups: twenty-six of the minute's thirty.
    assert.equal(structured<{ added: unknown[] }>((await writeAs(env, 'alice-uid', 'create_list', { name: 'First', paperIds: works(1, 25) })).answer).added.length, 25);
    const asked = providerCalls(calls).length;
    const refused = await writeAs(env, 'alice-uid', 'create_list', { name: 'Second', paperIds: works(26, 30) });
    assert.equal(refused.answer.result?.isError, true);
    assert.deepEqual(structured(refused.answer), { code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: 60 });
    assert.equal(providerCalls(calls).length, asked, 'no paper of a refused call is looked up');
    assert.equal(store.commits.length, 1);
    // The refused call was itself the twenty-seventh. A list with one paper takes two more, and a get_paper the last.
    assert.equal((await writeAs(env, 'alice-uid', 'create_list', { name: 'Third', paperIds: ['W31'] })).answer.result?.isError, undefined);
    assert.equal((await writeAs(env, 'alice-uid', 'get_paper', { id: 'W32' })).answer.result?.isError, undefined);
    assert.equal(structured<{ code: string }>((await writeAs(env, 'alice-uid', 'get_paper', { id: 'W33' })).answer).code, 'PROVIDER_RATE_LIMITED');
  });
});

test('a write tool reports a Firestore that refuses the write, and gives the day back', async () => {
  const store = fakeFirestore({});
  let down = true;
  await withUpstream((url, init) => {
    if (down && url.endsWith(':commit')) return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
    return store.answer(url, init) ?? providers(url, init);
  }, async () => {
    const env = accountEnv();
    for (let call = 0; call < 25; call += 1) {
      minutesLater(call);
      const { answer } = await writeAs(env, 'alice-uid', 'create_list', { name: `List ${call}` });
      assert.deepEqual(structured(answer), { code: 'UPSTREAM_UNAVAILABLE' }, `call ${call + 1}`);
    }
    down = false;
    minutesLater(25);
    assert.equal((await writeAs(env, 'alice-uid', 'create_list', { name: 'List' })).answer.result?.isError, undefined, 'the failed calls spent none of the twenty');
    // Without the service account nothing can be written, and the tool says so.
    const { answer } = await writeAs(accountEnv({ FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: undefined }), 'alice-uid', 'create_feed', { name: 'Graphene', fromPaperId: 'W4400000001' });
    assert.deepEqual(structured(answer), { code: 'ACCOUNT_DATA_NOT_CONFIGURED' });
  });
});

const TOPIC_INGREDIENTS = WRITTEN_FEED_INGREDIENTS;

test("create_feed builds a feed from a paper's own topics, and its first authors when asked", async () => {
  await withWrites({}, async (store, calls) => {
    const env = accountEnv();
    const { answer } = await writeAs(env, 'alice-uid', 'create_feed', { name: '  Strain ', fromPaperId: '10.1234/example.2026.1' });
    assert.equal(answer.result?.isError, undefined);
    const { feed } = structured<{ feed: { id: string } }>(answer);
    assert.match(feed.id, /^[0-9a-f]{16}$/);
    // The primary topic first, then the others in OpenAlex's order, three in all.
    const stored = { id: feed.id, name: 'Strain', order: 'newest', ingredients: TOPIC_INGREDIENTS };
    assert.deepEqual(structured(answer), { feed: { ...stored, url: `https://papertok.app/feeds/${feed.id}` }, notAdded: [] });

    // The document the app writes: `feeds` and `updatedAt`, and no other key.
    assert.equal(store.commits.length, 1);
    const [write] = store.commits[0];
    assert.equal(store.commits[0].length, 1);
    assert.equal(write.update?.name, `${FIRESTORE_ROOT}/${FEEDS_PATH}`);
    assert.deepEqual(Object.keys(write.update.fields).sort(), ['feeds', 'updatedAt']);
    assert.deepEqual(write.update?.fields.updatedAt, { timestampValue: NOON });
    // The document the rules suite checks the owner can still change.
    assert.deepEqual(store.documents[FEEDS_PATH], writtenFeeds(feed.id));

    const second = await writeAs(env, 'alice-uid', 'create_feed', { name: 'People', order: 'best', fromPaperId: 'W4400000001', include: ['authors', 'topics'] });
    const withAuthors = structured<{ feed: { id: string; order: string; ingredients: unknown[] }; notAdded: unknown[] }>(second.answer);
    assert.equal(withAuthors.feed.order, 'best');
    assert.deepEqual(withAuthors.feed.ingredients, [
      ...TOPIC_INGREDIENTS,
      { kind: 'author', id: 'A5001', label: 'Ana Pérez' },
      { kind: 'author', id: 'A5002', label: 'Luis Gómez' },
      { kind: 'author', id: 'A5003', label: 'Rosa Díaz' },
    ]);
    // The reader's first feed stays, and the new one comes after it.
    assert.deepEqual((store.documents[FEEDS_PATH] as { feeds: Array<{ id: string }> }).feeds.map(entry => entry.id), [feed.id, withAuthors.feed.id]);
    assert.ok(!JSON.stringify(store.documents[FEEDS_PATH]).includes('keyword'), 'no keyword is made up from the paper');

    // An arXiv id is asked of OpenAlex by arXiv's own DOI; a paper OpenAlex does not hold makes no feed.
    const unknown = await writeAs(env, 'alice-uid', 'create_feed', { name: 'Lab', fromPaperId: 'arXiv:2603.01234v2' });
    assert.deepEqual(structured(unknown.answer), { code: 'NOT_FOUND' });
    assert.ok(decodeURIComponent(providerCalls(calls).at(-1)!).startsWith('https://api.openalex.org/works/doi:10.48550/arxiv.2603.01234'));
    // A paper OpenAlex gives no topic makes none either.
    const bare = await writeAs(env, 'alice-uid', 'create_feed', { name: 'Bare', fromPaperId: 'W77' });
    assert.deepEqual(structured(bare.answer), { code: 'NO_FEED_INGREDIENTS', notAdded: [] });
    assert.equal(store.commits.length, 2);
  });
});

test("create_feed stores OpenAlex's name for a topic, author or journal, never the caller's", async () => {
  await withWrites({}, async (store, calls) => {
    const { answer } = await writeAs(accountEnv(), 'alice-uid', 'create_feed', {
      name: 'Mixed',
      ingredients: [
        { kind: 'area', id: 'physics' },
        { kind: 'category', id: 'cond-mat.mes-hall' },
        { kind: 'keyword', query: '  Twisted  Bilayer ' },
        { kind: 'author', id: 'https://openalex.org/A5001', label: 'Albert Einstein' },
        { kind: 'topic', id: 'T10001' },
        { kind: 'topic', id: 'C2001', label: '' },
        { kind: 'journal', id: 'S3001', label: 'Nature' },
        // OpenAlex holds no such author.
        { kind: 'author', id: 'A404', label: 'Nobody At All' },
        { kind: 'category', id: 'not-a-category' },
        'physics',
        { kind: 'author', id: 'Ana Pérez', label: 'Ana Pérez' },
        { kind: 'area', id: 'physics' },
      ],
    });
    assert.equal(answer.result?.isError, undefined);
    const result = structured<{ feed: { id: string; ingredients: unknown[] }; notAdded: unknown[] }>(answer);
    assert.deepEqual(result.feed.ingredients, [
      { kind: 'area', id: 'physics' },
      { kind: 'category', id: 'cond-mat.mes-hall' },
      { kind: 'keyword', query: 'twisted bilayer' },
      { kind: 'author', id: 'A5001', label: 'Ana Pérez' },
      { kind: 'topic', id: 'T10001', label: 'Graphene and two-dimensional materials' },
      { kind: 'topic', id: 'C2001', label: 'Condensed matter physics' },
      { kind: 'journal', id: 'S3001', label: 'Journal of Sheets' },
    ]);
    assert.deepEqual(result.notAdded, [
      { index: 7, ingredient: { kind: 'author', id: 'A404' }, code: 'NOT_FOUND' },
      { index: 8, code: 'INVALID_INGREDIENT' },
      { index: 9, code: 'INVALID_INGREDIENT' },
      { index: 10, code: 'INVALID_INGREDIENT' },
      { ingredient: { kind: 'area', id: 'physics' }, code: 'DUPLICATE' },
    ]);
    const written = JSON.stringify(store.documents);
    for (const label of ['Albert Einstein', 'Nature', 'Nobody At All', 'A404']) assert.ok(!written.includes(label), label);
    assert.deepEqual(providerCalls(calls).map(url => new URL(url).pathname).sort(), ['/authors/A404', '/authors/A5001', '/concepts/C2001', '/sources/S3001', '/topics/T10001']);
  });
});

test('create_feed looks up ten entities a call, and an entity OpenAlex answers under another id is not stored', async () => {
  await withWrites({}, async (store, calls) => {
    const env = accountEnv();
    const authors = Array.from({ length: 11 }, (_, index) => ({ kind: 'author', id: `A${601 + index}` }));
    const { answer } = await writeAs(env, 'alice-uid', 'create_feed', { name: 'Many', ingredients: [...authors, { kind: 'area', id: 'physics' }] });
    const result = structured<{ feed: { ingredients: unknown[] }; notAdded: Array<{ index: number; code: string }> }>(answer);
    assert.deepEqual(result.feed.ingredients, [{ kind: 'area', id: 'physics' }]);
    assert.deepEqual(result.notAdded.map(entry => [entry.index, entry.code]), [...authors.slice(0, 10).map((_, index) => [index, 'NOT_FOUND']), [10, 'TOO_MANY_LOOKUPS']]);
    assert.equal(providerCalls(calls).length, 10);
  });
  // A merged author: OpenAlex answers the old id with the record it became.
  await withWrites({}, async store => {
    minutesLater(1);
    const { answer } = await writeAs(accountEnv(), 'alice-uid', 'create_feed', { name: 'Merged', ingredients: [{ kind: 'author', id: 'A700' }] });
    assert.equal(answer.result?.isError, true);
    assert.deepEqual(structured(answer), { code: 'NO_FEED_INGREDIENTS', notAdded: [{ index: 0, ingredient: { kind: 'author', id: 'A700' }, code: 'ENTITY_NOT_CONFIRMED' }] });
    assert.deepEqual(store.commits, []);
  }, url => (url.startsWith('https://api.openalex.org/authors/A700') ? Response.json(namedEntity('authors/A5001')) : providers(url)));
});

const feedOf = (id: string, name: string, ingredients: object[]) => ({ id, name, order: 'newest', ingredients });
const authorsFrom = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'author', id: `A${from + index}`, label: `Author ${from + index}` }));
const PHYSICS = { kind: 'area', id: 'physics' };

test('create_feed holds the limits of the app: eight feeds, one name each, and the ceilings of the account', async () => {
  const eight = Array.from({ length: 8 }, (_, index) => feedOf(`feedaaaa${index}`, `Feed ${index + 1}`, [PHYSICS]));
  await withWrites({ [FEEDS_PATH]: { feeds: eight, updatedAt: new Date(NOON) } }, async (store, calls) => {
    const { answer } = await writeAs(accountEnv(), 'alice-uid', 'create_feed', { name: 'Ninth', ingredients: [{ kind: 'author', id: 'A5001' }] });
    assert.equal(answer.result?.isError, true);
    assert.deepEqual(structured(answer), { code: 'FEED_LIMIT_REACHED', limit: 8 });
    assert.deepEqual(providerCalls(calls), [], 'a full account asks no provider');
    assert.deepEqual(store.commits, []);
  });

  // Thirty authors across two feeds, and ten keywords: the account's ceilings.
  const keywords = Array.from({ length: 10 }, (_, index) => ({ kind: 'keyword', query: `keyword ${index + 1}` }));
  const full = [feedOf('feedaaaa1', 'Graphene', [...authorsFrom(1, 20)]), feedOf('feedaaaa2', 'More', [...authorsFrom(21, 10), ...keywords])];
  await withWrites({ [FEEDS_PATH]: { feeds: full, updatedAt: new Date(NOON) } }, async store => {
    const env = accountEnv();
    for (const name of ['Graphene', '  graphene ']) {
      const taken = await writeAs(env, 'alice-uid', 'create_feed', { name, ingredients: [PHYSICS] });
      assert.deepEqual(structured(taken.answer), { code: 'FEED_NAME_TAKEN' }, name);
    }
    // A new author and a new keyword pass the ceilings; an author the account already follows does not.
    const { answer } = await writeAs(env, 'alice-uid', 'create_feed', {
      name: 'Third',
      ingredients: [{ kind: 'author', id: 'A5001' }, { kind: 'keyword', query: 'one more' }, { kind: 'author', id: 'A7' }, PHYSICS],
    });
    const result = structured<{ feed: { ingredients: unknown[] }; notAdded: unknown[] }>(answer);
    assert.deepEqual(result.feed.ingredients, [{ kind: 'author', id: 'A7', label: 'Seventh Author' }, PHYSICS]);
    assert.deepEqual(result.notAdded, [
      { ingredient: { kind: 'author', id: 'A5001' }, code: 'ENTITIES_FULL' },
      { ingredient: { kind: 'keyword', query: 'one more' }, code: 'KEYWORDS_FULL' },
    ]);
    assert.equal((store.documents[FEEDS_PATH] as { feeds: unknown[] }).feeds.length, 3);
    // When every ingredient meets a ceiling, no feed is made.
    const none = await writeAs(env, 'alice-uid', 'create_feed', { name: 'Fourth', ingredients: [{ kind: 'author', id: 'A5002' }] });
    assert.equal(none.answer.result?.isError, true);
    assert.deepEqual(structured(none.answer), { code: 'NO_FEED_INGREDIENTS', notAdded: [{ ingredient: { kind: 'author', id: 'A5002' }, code: 'ENTITIES_FULL' }] });
    assert.equal(store.commits.length, 1);
  }, url => (url.startsWith('https://api.openalex.org/authors/A7?') ? Response.json({ id: 'https://openalex.org/A7', display_name: 'Seventh Author' }) : providers(url)));
});

test('create_feed checks the limits against the feeds as its write finds them', async () => {
  const seven = Array.from({ length: 7 }, (_, index) => feedOf(`feedaaaa${index}`, `Feed ${index + 1}`, [PHYSICS]));
  const stored = (feeds: object[]) => ({ feeds, updatedAt: new Date(NOON) });
  await withWrites({ [FEEDS_PATH]: stored(seven) }, async store => {
    const env = accountEnv();
    const create = async (name: string, requestId?: string) => (await writeAs(env, 'alice-uid', 'create_feed', { name, ingredients: [PHYSICS], requestId })).answer;
    // The reader makes an eighth feed in the app while the tool runs.
    store.hooks.beforeCommit = () => store.write(FEEDS_PATH, stored([...seven, feedOf('feedaaaa7', 'Feed 8', [PHYSICS])]));
    assert.deepEqual(structured(await create('Mine')), { code: 'FEED_LIMIT_REACHED', limit: 8 });
    // Or gives another feed the name the tool was asked for.
    store.write(FEEDS_PATH, stored(seven.slice(0, 2)));
    store.hooks.beforeCommit = () => store.write(FEEDS_PATH, stored([seven[0], { ...seven[1], name: 'Mine' }]));
    assert.deepEqual(structured(await create('mine')), { code: 'FEED_NAME_TAKEN' });
    assert.deepEqual(store.commits, []);
    // A change that leaves room is kept, and the feed is added to it.
    store.hooks.beforeCommit = () => store.write(FEEDS_PATH, stored([seven[0], { ...seven[1], name: 'Renamed' }]));
    const made = structured<{ feed: { id: string } }>(await create('Ours', 'feed-retry-1'));
    assert.deepEqual((store.documents[FEEDS_PATH] as { feeds: Array<{ name: string }> }).feeds.map(feed => feed.name), ['Feed 1', 'Renamed', 'Ours']);
    assert.equal(store.commits.length, 1);
    // The same call again returns the feed it made, though its name is now taken by that feed.
    const existing = {
      feed: { id: made.feed.id, name: 'Ours', order: 'newest', ingredients: [PHYSICS], url: `https://papertok.app/feeds/${made.feed.id}` },
      existing: true,
    };
    assert.deepEqual(structured(await create('Ours', 'feed-retry-1')), existing);
    // The first call with a requestId wins: reused for another name, order and
    // ingredients, it returns the first feed and changes nothing.
    const reused = await writeAs(env, 'alice-uid', 'create_feed', { name: 'Another', order: 'best', ingredients: [{ kind: 'keyword', query: 'twisted bilayer' }], requestId: 'feed-retry-1' });
    assert.equal(reused.answer.result?.isError, undefined);
    assert.deepEqual(structured(reused.answer), existing);
    assert.deepEqual((store.documents[FEEDS_PATH] as { feeds: Array<{ name: string }> }).feeds.map(feed => feed.name), ['Feed 1', 'Renamed', 'Ours']);
    assert.equal(store.commits.length, 1);
    // Feeds that change under both attempts are left as they are.
    const touch = () => {
      store.write(FEEDS_PATH, { ...store.documents[FEEDS_PATH] });
      store.hooks.beforeCommit = touch;
    };
    store.hooks.beforeCommit = touch;
    const changed = await create('Theirs');
    store.hooks.beforeCommit = undefined;
    assert.deepEqual(structured(changed), { code: 'FEEDS_CHANGED' });
    assert.equal(store.commits.length, 1);
  });
});

test("an account's agents create twenty feeds a UTC day, and a call that creates none spends none of them", async () => {
  await withWrites({}, async store => {
    const env = accountEnv();
    for (let call = 0; call < 3; call += 1) {
      assert.equal(structured<{ code: string }>((await writeAs(env, 'alice-uid', 'create_feed', { name: `None ${call}`, ingredients: ['nothing'] })).answer).code, 'NO_FEED_INGREDIENTS');
    }
    for (let made = 0; made < 20; made += 1) {
      // The reader deletes each feed, so the account never holds eight.
      store.write(FEEDS_PATH, null);
      assert.equal((await writeAs(env, 'alice-uid', 'create_feed', { name: `Feed ${made + 1}`, ingredients: [PHYSICS] })).answer.result?.isError, undefined, `feed ${made + 1}`);
    }
    store.write(FEEDS_PATH, null);
    const refused = await writeAs(env, 'alice-uid', 'create_feed', { name: 'Feed 21', ingredients: [PHYSICS] });
    assert.equal(refused.answer.result?.isError, true);
    assert.deepEqual(structured(refused.answer), { code: 'FEEDS_DAILY_LIMIT', limit: 20, remaining: 0, retryAfterSeconds: secondsToMidnight(0) });
    assert.equal(store.commits.length, 20);
    assert.equal(store.documents[FEEDS_PATH], undefined);
  });
});
