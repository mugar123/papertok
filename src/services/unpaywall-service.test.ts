import test from 'node:test';
import assert from 'node:assert/strict';
import { findOpenAccessCopy, mapUnpaywallResult, normalizeDoi } from './unpaywall-service.ts';

// The module caches by DOI for the whole process, so each test uses its own.
async function withUpstream<T>(respond: () => Response | Promise<Response>, callback: (state: { calls: string[]; store: Map<string, string> }) => T): Promise<Awaited<T>> {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>();
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return respond(); };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key) : null),
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  try {
    return await callback({ calls, store });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
  }
}

const jsonResponse = (payload: { error?: string; doi?: string; is_oa?: boolean|null; best_oa_location?: null; source?: string; }, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('normalizes DOI values', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/ABC'), '10.1000/abc');
  assert.equal(normalizeDoi('doi: 10.42/Test'), '10.42/test');
});

test('maps only safe Unpaywall locations', () => {
  assert.deepEqual(mapUnpaywallResult({ best_oa_location: {
    url_for_pdf: 'https://repository.example/paper.pdf',
    url_for_landing_page: 'https://repository.example/paper',
    license: 'cc-by',
    repository_institution: 'Example University',
  } }), {
    pdfUrl: 'https://repository.example/paper.pdf',
    landingPageUrl: 'https://repository.example/paper',
    license: 'cc-by',
    version: undefined,
    hostType: undefined,
    repositoryInstitution: 'Example University',
    accessSource: 'unpaywall',
  });
  assert.equal(mapUnpaywallResult({ best_oa_location: { url: 'javascript:alert(1)' } }), null);
});

// Medido sobre una muestra de DOIs verdes (2026-08-29): cinco de trece copias
// llegaban solo como `http://`. La app abre exclusivamente `https:`, así que
// cada una era un clic que no hacía nada.
test('sube a HTTPS las copias que Unpaywall entrega en claro', () => {
  assert.deepEqual(mapUnpaywallResult({ best_oa_location: {
    url_for_pdf: 'http://repository.example/paper.pdf',
    url_for_landing_page: 'http://repository.example/paper',
  } }), {
    pdfUrl: 'https://repository.example/paper.pdf',
    landingPageUrl: 'https://repository.example/paper',
    license: undefined,
    version: undefined,
    hostType: undefined,
    repositoryInstitution: undefined,
    accessSource: 'unpaywall',
  });
});

test('a copy the Worker read from a Crossref licence says it came from Crossref', () => {
  const doi = '10.1080/07853890.2026.2726635';
  assert.deepEqual(mapUnpaywallResult({
    doi,
    is_oa: true,
    source: 'crossref',
    best_oa_location: {
      host_type: 'publisher',
      version: 'publishedVersion',
      license: 'cc-by',
      url: `https://doi.org/${doi}`,
      url_for_landing_page: `https://doi.org/${doi}`,
      url_for_pdf: null!,
      evidence: 'crossref license',
      is_best: true,
    } as NonNullable<NonNullable<Parameters<typeof mapUnpaywallResult>[0]>['best_oa_location']> & Record<string, unknown>,
  } as Parameters<typeof mapUnpaywallResult>[0] & { doi: string }), {
    pdfUrl: undefined,
    landingPageUrl: `https://doi.org/${doi}`,
    license: 'cc-by',
    version: 'publishedVersion',
    hostType: 'publisher',
    repositoryInstitution: undefined,
    accessSource: 'crossref',
  });
});

test('a failed lookup is not asked again on every visit in the same session', async () => {
  await withUpstream(() => jsonResponse({ error: 'Open-access lookup unavailable' }, 502), async ({ calls }) => {
    assert.equal(await findOpenAccessCopy('10.5555/transient-once'), null);
    assert.equal(await findOpenAccessCopy('10.5555/transient-once'), null);
    assert.equal(calls.length, 1);
  });
});

test('a failed lookup is not remembered across a reload', async () => {
  await withUpstream(() => jsonResponse({ error: 'Open-access lookup unavailable' }, 502), async ({ store }) => {
    await findOpenAccessCopy('10.5555/transient-not-persisted');
    assert.equal(store.has('papertok_oa_10.5555/transient-not-persisted'), false);
  });
});

test('a DOI nobody could answer for yet is asked again hours later, a closed one is not', async () => {
  const realNow = Date.now;
  let now = Date.parse('2026-09-23T10:00:00Z');
  Date.now = () => now;
  try {
    const unresolved = await withUpstream(
      () => jsonResponse({ doi: '10.5555/unresolved', is_oa: null, best_oa_location: null, source: 'unresolved' }),
      async ({ calls }) => {
        await findOpenAccessCopy('10.5555/unresolved');
        now += 7 * 60 * 60 * 1000;
        await findOpenAccessCopy('10.5555/unresolved');
        return calls.length;
      },
    );
    now = Date.parse('2026-09-23T10:00:00Z');
    const closed = await withUpstream(
      () => jsonResponse({ doi: '10.5555/closed', is_oa: false, best_oa_location: null }),
      async ({ calls }) => {
        await findOpenAccessCopy('10.5555/closed');
        now += 7 * 60 * 60 * 1000;
        await findOpenAccessCopy('10.5555/closed');
        return calls.length;
      },
    );
    assert.equal(unresolved, 2, 'the unresolved DOI is looked up again after seven hours');
    assert.equal(closed, 1, 'a DOI Unpaywall called closed keeps its answer for the day');
  } finally {
    Date.now = realNow;
  }
});
