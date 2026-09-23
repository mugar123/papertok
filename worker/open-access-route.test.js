import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './report-api.js';

const DOI = '10.1080/07853890.2026.2726635';
const ORIGIN = 'https://papertok.app';

// What Unpaywall actually answers for a DOI it has not indexed yet: an HTML
// page, not JSON (measured 2026-09-23 on DOIs registered that morning).
const UNPAYWALL_NOT_FOUND = () => new Response(
  '<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>',
  { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

const crossrefWork = (license) => new Response(JSON.stringify({
  status: 'ok',
  'message-type': 'work',
  'message-version': '1.0.0',
  message: {
    DOI,
    URL: `https://doi.org/${DOI}`,
    type: 'journal-article',
    title: ['An Annals of Medicine article'],
    license,
  },
}), { headers: { 'content-type': 'application/json' } });

const CC_BY_VOR = [{
  start: { 'date-parts': [[2026, 9, 22]], 'date-time': '2026-09-22T00:00:00Z', timestamp: 1790035200000 },
  'content-version': 'vor',
  'delay-in-days': 0,
  URL: 'http://creativecommons.org/licenses/by/4.0/',
}];
const TDM_ONLY = [{
  start: { 'date-parts': [[2026, 9, 1]], 'date-time': '2026-09-01T00:00:00Z', timestamp: 1788220800000 },
  'content-version': 'tdm',
  'delay-in-days': 0,
  URL: 'https://www.elsevier.com/tdm/userlicense/1.0/',
}];

async function lookUp(upstream) {
  const calls = [];
  const puts = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith('https://api.unpaywall.org/')) return upstream.unpaywall();
    if (url.startsWith('https://api.crossref.org/')) return upstream.crossref();
    throw new Error(`unexpected upstream ${url}`);
  };
  globalThis.caches = {
    default: {
      match: async () => null,
      put: async (key, response) => { puts.push(response); },
    },
  };
  try {
    const response = await reportApi.fetch(new Request(
      `https://papertok-report-api.example/oa?doi=${encodeURIComponent(DOI)}`,
      { headers: { origin: ORIGIN } },
    ), {});
    return { response, body: await response.json(), calls, puts };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

test('a DOI Unpaywall has not indexed yet is answered from its Crossref licence', async () => {
  const { response, body, calls, puts } = await lookUp({
    unpaywall: UNPAYWALL_NOT_FOUND,
    crossref: () => crossrefWork(CC_BY_VOR),
  });

  assert.equal(response.status, 200);
  assert.equal(body.is_oa, true);
  assert.equal(body.source, 'crossref');
  assert.deepEqual(body.best_oa_location, {
    host_type: 'publisher',
    version: 'publishedVersion',
    license: 'cc-by',
    url: `https://doi.org/${DOI}`,
    url_for_landing_page: `https://doi.org/${DOI}`,
    url_for_pdf: null,
    evidence: 'crossref license',
    is_best: true,
  });
  assert.equal(calls.filter(url => url.startsWith('https://api.crossref.org/')).length, 1);
  assert.match(response.headers.get('cache-control'), /s-maxage=604800\b/);
  assert.equal(puts.length, 1);
});

test('a DOI nobody can answer for yet is cached briefly as unresolved, not failed as a 502', async () => {
  const { response, body, puts } = await lookUp({
    unpaywall: UNPAYWALL_NOT_FOUND,
    crossref: () => crossrefWork(TDM_ONLY),
  });

  assert.equal(response.status, 200);
  assert.equal(body.source, 'unresolved');
  assert.equal(body.is_oa, null);
  assert.equal(body.best_oa_location, null);
  // Six hours: long enough to stop a card asking on every visit, short enough
  // to pick the paper up the day Unpaywall indexes it.
  assert.match(response.headers.get('cache-control'), /s-maxage=21600\b/);
  assert.equal(puts.length, 1);
});

test('a DOI Crossref does not hold either is unresolved too', async () => {
  const { response, body } = await lookUp({
    unpaywall: UNPAYWALL_NOT_FOUND,
    crossref: () => new Response('Resource not found.', { status: 404 }),
  });

  assert.equal(response.status, 200);
  assert.equal(body.source, 'unresolved');
});

test('an Unpaywall outage stays an outage: no Crossref guess and nothing cached', async () => {
  const { response, body, calls, puts } = await lookUp({
    unpaywall: () => new Response('upstream down', { status: 503 }),
    crossref: () => crossrefWork(CC_BY_VOR),
  });

  assert.equal(response.status, 502);
  assert.equal(body.upstreamStatus, 503);
  assert.equal(calls.some(url => url.startsWith('https://api.crossref.org/')), false);
  assert.equal(puts.length, 0);
});

test('when Crossref is down behind an Unpaywall miss, the answer is an outage, not a cached "unknown"', async () => {
  const { response, puts } = await lookUp({
    unpaywall: UNPAYWALL_NOT_FOUND,
    crossref: () => new Response('down', { status: 500 }),
  });

  assert.equal(response.status, 502);
  assert.equal(puts.length, 0);
});

test('a DOI Unpaywall knows is relayed as it answered, without asking Crossref', async () => {
  const unpaywallPayload = {
    doi: DOI,
    is_oa: true,
    best_oa_location: {
      host_type: 'publisher',
      license: 'cc-by',
      url: `https://doi.org/${DOI}`,
      url_for_landing_page: `https://doi.org/${DOI}`,
      url_for_pdf: null,
      version: 'publishedVersion',
    },
  };
  const { response, body, calls } = await lookUp({
    unpaywall: () => new Response(JSON.stringify(unpaywallPayload), { headers: { 'content-type': 'application/json' } }),
    crossref: () => crossrefWork(CC_BY_VOR),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(body, unpaywallPayload);
  assert.equal(calls.some(url => url.startsWith('https://api.crossref.org/')), false);
  assert.match(response.headers.get('cache-control'), /s-maxage=604800\b/);
});
