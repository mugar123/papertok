import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.papertok.app';
const SITE = 'https://papertok.app';
const browserOrigin = { Origin: SITE };

const probes = {
  'Worker health': { url: API + '/health' },
  'AI health': { url: API + '/health/ai' },
  'ORCID connect': { url: API + '/orcid/connect', init: { method: 'POST', headers: browserOrigin } },
  'MCP search': {
    url: API + '/mcp',
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_papers', arguments: { query: 'attention is all you need', sources: ['openalex'], limit: 1 } },
      }),
    },
  },
  'Guest papers': {
    url: API + '/sources/huggingface?q=transformer&limit=1',
    init: { headers: browserOrigin },
  },
  'Website': { url: SITE },
} satisfies Record<string, { url: string; init?: RequestInit }>;

type Probe = keyof typeof probes;
type Body = {
  ok?: unknown;
  available?: unknown;
  code?: unknown;
  version?: { id?: unknown; tag?: unknown };
  papers?: unknown;
  error?: unknown;
  result?: { isError?: unknown; structuredContent?: { papers?: unknown } };
};

const diagnosticCodes = new Set([
  'AI_NOT_CONFIGURED', 'AI_QUOTA_EXHAUSTED', 'AI_BUSY', 'AI_TIMEOUT', 'AI_UNAVAILABLE',
  'ORCID_NOT_CONFIGURED', 'AUTH_REQUIRED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_TIMEOUT',
]);

function publicVersion(value: unknown) {
  return typeof value === 'string' && /^[\w.-]{1,128}$/.test(value) ? value : null;
}

export function classifyProductionProbe(probe: Probe, status: number, body: Body | null = null) {
  const code = body?.code;
  const http = typeof code === 'string' && diagnosticCodes.has(code) ? `HTTP ${status} ${code}` : `HTTP ${status}`;
  if (probe === 'ORCID connect') {
    const passed = status === 401 && code === 'AUTH_REQUIRED';
    return { passed, detail: passed ? http : `${http} (expected 401 AUTH_REQUIRED)` };
  }
  if (status !== 200) return { passed: false, detail: http };

  switch (probe) {
    case 'Worker health': {
      if (body?.ok !== true) return { passed: false, detail: 'Expected ok: true' };
      const id = publicVersion(body.version?.id);
      const tag = body.version?.tag === null ? 'untagged' : publicVersion(body.version?.tag);
      if (!id || !tag) return { passed: false, detail: 'Missing or invalid deployment version metadata' };
      return {
        passed: true,
        detail: `version id ${id}, tag ${tag}`,
      };
    }
    case 'AI health':
      return body?.available === true
        ? { passed: true, detail: 'Provider available' }
        : { passed: false, detail: 'Expected available: true' };
    case 'MCP search': {
      const papers = body?.result?.structuredContent?.papers;
      const passed = !body?.error && body?.result?.isError !== true && Array.isArray(papers) && papers.length > 0;
      return { passed, detail: passed ? 'Returned papers' : 'Expected papers in a successful MCP tool result' };
    }
    case 'Guest papers': {
      const passed = Array.isArray(body?.papers) && body.papers.length > 0;
      return { passed, detail: passed ? 'Returned papers' : 'Expected a non-empty papers array' };
    }
    case 'Website':
      return { passed: true, detail: http };
  }
}

async function runProbe(probe: Probe) {
  const { url, init }: { url: string; init?: RequestInit } = probes[probe];
  const signal = AbortSignal.timeout(20_000);
  try {
    const response = await fetch(url, { ...init, signal, redirect: 'manual' });
    if (probe === 'Website') {
      await response.body?.cancel();
      return classifyProductionProbe(probe, response.status);
    }
    const body = await response.json().catch(() => null) as Body | null;
    if (signal.aborted) return { passed: false, detail: 'Timed out after 20 seconds' };
    return classifyProductionProbe(probe, response.status, body);
  } catch {
    return { passed: false, detail: signal.aborted ? 'Timed out after 20 seconds' : 'Request failed' };
  }
}

async function main() {
  const checks = await Promise.all((Object.keys(probes) as Probe[]).map(async (probe) => ({
    probe,
    ...await runProbe(probe),
  })));
  for (const { probe, passed, detail } of checks) {
    console.log(`- ${passed ? 'PASS' : 'FAIL'} ${probe}: ${detail}`);
  }
  if (checks.some(({ passed }) => !passed)) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
