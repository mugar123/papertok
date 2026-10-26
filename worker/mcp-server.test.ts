import type { WorkerEnv } from './env.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { trackErrors } from './error-tracking.ts';
import reportApi from './index.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

const SECRET = 'test-only-pdf-rate-limit-key-32-bytes';

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

type Upstream = (url: string) => Response | Promise<Response>;

interface RpcAnswer {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown> & {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text: string }>;
    tools?: Array<{ name: string; inputSchema: { type: string }; annotations?: { readOnlyHint?: boolean } }>;
  };
  error?: { code: number; message: string };
}

async function withUpstream<T>(upstream: Upstream, run: (calls: string[]) => Promise<T>) {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async input => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return upstream(url);
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (): Promise<Response | null | undefined> => null,
      put: async (): Promise<void> => {},
    },
  };
  try {
    return await run(calls);
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
    'primaryCategory', 'primaryTopic', 'sourceType', 'provider'];
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

test("an arXiv record's DOI alone does not make its paper peer reviewed, in a search and in get_paper", async () => {
  // arXiv lists a DOI and nothing else: no journal reference, no comment.
  const doiOnly = ARXIV_LAB_ENTRY.replace('<author>', '<arxiv:doi>10.5281/zenodo.99999</arxiv:doi><author>');
  const inJournal = ARXIV_LAB_ENTRY
    .replace('2603.01234', '2603.04321')
    .replace('<author>', '<arxiv:doi>10.1234/sheets.2026.7</arxiv:doi><arxiv:journal_ref>Journal of Sheets 12, 34 (2026)</arxiv:journal_ref><author>');
  await withUpstream(url => {
    if (url.includes('id_list=2603.04321')) return new Response(arxivFeed(inJournal));
    if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(arxivFeed(doiOnly));
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    // Separate environments, so each arXiv request finds the beat's seat free.
    const searched = await callTool(routeEnv(), 'search_papers', { query: 'strained graphene', sources: ['arxiv'] });
    const [listed] = searched.answer.result?.structuredContent?.papers as Array<Record<string, unknown>>;
    const looked = await callTool(routeEnv(), 'get_paper', { id: '2603.01234' });
    const paper = looked.answer.result?.structuredContent?.paper as Record<string, unknown>;
    for (const [name, relayed] of [['search', listed], ['get_paper', paper]] as const) {
      assert.equal(relayed.doi, '10.5281/zenodo.99999', name);
      assert.equal('peerReviewed' in relayed, false, name);
    }
    // A journal reference is evidence of its own.
    const published = await callTool(routeEnv(), 'get_paper', { id: '2603.04321' });
    assert.equal((published.answer.result?.structuredContent?.paper as { peerReviewed?: boolean }).peerReviewed, true);
  });
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
      source: { display_name: 'SSRN Electronic Journal', type: 'repository' },
    },
  };
  await withUpstream(url => {
    if (url.startsWith('https://api.openalex.org/works/W4400000088')) return Response.json(ssrn);
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [ssrn] });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const env = routeEnv();
    const searched = await callTool(env, 'search_papers', { query: 'graphene prices', sources: ['openalex'] });
    const [listed] = searched.answer.result?.structuredContent?.papers as Array<Record<string, unknown>>;
    const looked = await callTool(env, 'get_paper', { id: 'W4400000088' });
    const paper = looked.answer.result?.structuredContent?.paper as Record<string, unknown>;
    for (const [name, relayed] of [['search', listed], ['get_paper', paper]] as const) {
      assert.equal(relayed.publicationType, 'preprint', name);
      assert.deepEqual(['sourceType', 'provider'].filter(key => key in relayed), [], name);
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
    if (filtered(url, '2603.01234')) return Response.json({ results: [OPENALEX_LAB_PREPRINT] });
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
      ['find_open_access', { doi: '2603.01234' }],
    ] as const) {
      const { answer } = await callTool(env, name, args);
      assert.equal(answer.result?.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(answer.result?.structuredContent?.code, 'INVALID_ARGUMENTS');
    }
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
      const searched = await callTool(routeEnv(), 'search_papers', { query: 'graphene strain', sources: ['arxiv'] });
      assert.equal(searched.answer.result?.structuredContent?.code, 'SOURCES_UNAVAILABLE');
      assert.equal(searched.answer.result?.structuredContent?.retryAfterSeconds, 3);
      assert.deepEqual(calls, []);
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
