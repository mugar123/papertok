import type { WorkerEnv } from './env.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './index.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

const SECRET = 'test-only-pdf-rate-limit-key-32-bytes';
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

test('tools/list names the four read-only tools with input schemas', async () => {
  await withUpstream(NO_UPSTREAM, async () => {
    const { answer } = await rpc(routeEnv(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = answer.result?.tools || [];
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['find_open_access', 'get_citation_graph', 'get_paper', 'search_papers']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
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
    const { answer } = await callTool(routeEnv(), 'search_papers', { query: 'llama 2' });
    const papers = answer.result?.structuredContent?.papers as Array<{ arxivId?: string }>;
    assert.equal(papers.length, 10);
    assert.equal(papers[0].arxivId, '2307.09288');
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

test('get_citation_graph returns references and citing works without an account', async () => {
  const citing = { ...OPENALEX_WORK, id: 'https://openalex.org/W4400000002', doi: 'https://doi.org/10.1234/citing', title: 'A citing paper' };
  await withUpstream(url => {
    if (url.startsWith('https://api.opencitations.net/index/v2/references/')) return Response.json([]);
    if (url.startsWith('https://api.opencitations.net/index/v2/citations/')) return Response.json([]);
    if (url.startsWith('https://api.openalex.org/works/doi:')) return Response.json({ id: OPENALEX_WORK.id, referenced_works: [], cited_by_count: 1 });
    if (url.startsWith('https://api.openalex.org/works?') && url.includes('cites%3AW4400000001')) return Response.json({ results: [citing] });
    throw new Error(`unexpected upstream ${url}`);
  }, async () => {
    const { answer } = await callTool(routeEnv(), 'get_citation_graph', { doi: '10.1234/example.2026.1', limit: 3 });
    assert.equal(answer.result?.isError, undefined);
    const graph = answer.result?.structuredContent as { references: unknown[]; citations: Array<{ title: string }>; degraded: boolean };
    assert.deepEqual(graph.references, []);
    assert.deepEqual(graph.citations.map(paper => paper.title), ['A citing paper']);
    assert.equal(graph.degraded, false);
  });
});

test('citation graphs asked through MCP share one provider allowance, whoever asks', async () => {
  await withUpstream(url => {
    if (url.startsWith('https://api.opencitations.net/')) return Response.json([]);
    if (url.startsWith('https://api.openalex.org/works/doi:')) return Response.json({ id: OPENALEX_WORK.id, referenced_works: [], cited_by_count: 0 });
    if (url.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [] });
    throw new Error(`unexpected upstream ${url}`);
  }, async calls => {
    // One miss a minute for the credential-backed providers' subject.
    const env = routeEnv({ PROVIDER_USER_MINUTE_LIMIT: '1' });
    const ask = (doi: string, ip: string) => rpc(env, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_citation_graph', arguments: { doi } },
    }, { ip });
    const first = await ask('10.1234/first', '192.0.2.7');
    assert.equal(first.answer.result?.isError, undefined);
    const before = calls.length;
    const second = await ask('10.1234/second', '198.51.100.9');
    assert.equal(second.answer.result?.isError, true);
    assert.equal(second.answer.result?.structuredContent?.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(calls.length, before, 'a refused graph asks nothing upstream');
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
      ['get_citation_graph', { doi: '10.1/x' }],
    ] as const) {
      const { answer } = await callTool(env, name, args);
      assert.equal(answer.result?.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(answer.result?.structuredContent?.code, 'INVALID_ARGUMENTS');
    }
    assert.deepEqual(calls, []);
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
