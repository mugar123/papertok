import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadlineHarness.js';
import { CACHE, fetchWithTimeout, getProjectDetails, getPapersByProject, searchProjects } from './openAireService.js';

test('the deadline covers an OpenAIRE body that never finishes', async () => {
  // The worst shape of the family: the response comes back unread and
  // `searchProjects` reads it some hundred and sixty lines away, so clearing the
  // timer here left that read with nothing bounding it.
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout('https://api.openaire.eu/search/projects?keywords=deadline', 50);
        await response.json();
      }),
      'TimeoutError',
    );
  });
});

test('a caller signal does not take the OpenAIRE deadline away with it', async () => {
  // `SearchPage` aborts the in-flight project search on the next keystroke. That
  // signal is a cancellation, not a budget, so it has to add to the deadline
  // rather than replace it.
  const cancellation = new AbortController();
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout(
          'https://api.openaire.eu/search/projects?keywords=deadline',
          50,
          { signal: cancellation.signal },
        );
        await response.json();
      }),
      'TimeoutError',
    );
  });
});

test('a cancelled project search still reads as a cancellation', async () => {
  // `searchProjects` keeps quiet when `options.signal` aborted and logs
  // otherwise. Merging the deadline in must not turn a user cancellation into
  // something that looks like a timeout.
  const cancellation = new AbortController();
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout(
          'https://api.openaire.eu/search/projects?keywords=cancelled',
          60_000,
          { signal: cancellation.signal },
        );
        const body = response.json();
        cancellation.abort();
        await body;
      }),
      'AbortError',
    );
  });
});

/**
 * The only Explorer read with no cache: every return to a project paid a full
 * OpenAIRE round trip with the skeleton on screen (2026-09-09 review). The
 * same 24 h CACHE its two neighbours in this file use.
 */
test('getProjectDetails answers a second call from the cache without a request', async () => {
  let calls = 0;
  const stub = async () => {
    calls++;
    return new Response(JSON.stringify({
      response: {
        results: {
          result: [{
            header: { 'dri:objIdentifier': { $: 'corda__h2020::abc' } },
            metadata: {
              'oaf:entity': {
                'oaf:project': {
                  code: { $: '101000000' },
                  acronym: { $: 'QUANTUMLEAP' },
                  title: { $: 'Quantum leap' },
                  startdate: { $: '2021-01-01' },
                  enddate: { $: '2025-12-31' },
                  totalcost: { $: '4998750' },
                  fundedamount: { $: '4998750' },
                  currency: { $: 'EUR' },
                  fundingtree: { funder: { shortname: { $: 'EC' }, name: { $: 'European Commission' } } },
                },
              },
            },
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  CACHE.clear();
  try {
    await withStubbedFetch(stub, async () => {
      const first = await getProjectDetails('101000000');
      const second = await getProjectDetails('101000000');
      assert.equal(first?.acronym, 'QUANTUMLEAP');
      assert.deepEqual(second, first, 'the same object, from the cache');
      assert.equal(calls, 1, 'one request for two calls');
    });
  } finally {
    CACHE.clear();
  }
});

test('getProjectDetails does not cache a miss', async () => {
  let calls = 0;
  const stub = async () => { calls++; return new Response('{}', { status: 404 }); };
  CACHE.clear();
  try {
    await withStubbedFetch(stub, async () => {
      assert.equal(await getProjectDetails('nope'), null);
      assert.equal(await getProjectDetails('nope'), null);
      assert.equal(calls, 2, 'a miss is asked again — OpenAIRE indexes late');
    });
  } finally {
    CACHE.clear();
  }
});

const emptyOpenAire = { ok: true, json: async () => ({ response: { header: { total: { $: '0' } }, results: {} } }) };
function capturingFetch(urls) { return async (url) => { urls.push(String(url)); return emptyOpenAire; }; }

test('un id de OpenAIRE consulta los detalles por openaireProjectID', async () => {
  const urls = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), () => getProjectDetails('snsf________::abc'));
  assert.match(urls[0], /openaireProjectID=snsf________%3A%3Aabc/);
  assert.doesNotMatch(urls[0], /grantID=/);
});

test('un código a secas lleva el funder a detalles y a publicaciones', async () => {
  const urls = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), async () => {
    await getProjectDetails('100010', { funder: 'SNSF' });
    await getPapersByProject('100010', 1, { funder: 'SNSF' });
  });
  assert.match(urls[0], /grantID=100010/); assert.match(urls[0], /funder=SNSF/);
  assert.match(urls[1], /projectID=100010/); assert.match(urls[1], /funder=SNSF/);
});

test('sin funder las URLs quedan como antes', async () => {
  const urls = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), () => getPapersByProject('100010', 1));
  assert.doesNotMatch(urls[0], /funder=/);
});

/**
 * A search result carries two identifiers and they are not interchangeable.
 * `id` is the OpenAIRE object identifier (`dri:objIdentifier`), which names
 * exactly one project and is what every lookup and every route now uses;
 * `code` is the bare grant code, which three funders can be using at once.
 * `id` used to BE the bare code, and that silent change of meaning is what
 * orphaned every project follow written before it — the field had no test at
 * all.
 */
function projectSearchResponse(header, project) {
  return async () => ({
    ok: true,
    json: async () => ({
      response: {
        header: { total: { $: '1' } },
        results: { result: [{ header, metadata: { 'oaf:entity': { 'oaf:project': project } } }] },
      },
    }),
  });
}

test('searchProjects keeps the OpenAIRE id and the grant code in separate fields', async () => {
  const stub = projectSearchResponse(
    { 'dri:objIdentifier': { $: 'snsf________::daa28096f9e8879ab3a02b90aa0e2f83' } },
    {
      code: { $: '100010' },
      acronym: { $: 'LEAP' },
      title: { $: 'Quantum leap in photonics' },
      fundingtree: { funder: { shortname: { $: 'SNSF' } } },
    },
  );
  const { projects } = await withStubbedFetch(stub, () => searchProjects('quantum leap'));

  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'snsf________::daa28096f9e8879ab3a02b90aa0e2f83', 'id is the OpenAIRE object identifier');
  assert.equal(projects[0].code, '100010', 'code stays the bare grant code');
  assert.equal(projects[0].funder, 'SNSF');
});

test('searchProjects falls back to the grant code only when OpenAIRE sends no object identifier', async () => {
  const stub = projectSearchResponse({}, { code: { $: '100010' }, title: { $: 'Quantum leap in photonics' } });
  const { projects } = await withStubbedFetch(stub, () => searchProjects('quantum leap'));

  assert.equal(projects[0].id, '100010', 'a row with no OpenAIRE id is still routable');
  assert.equal(projects[0].code, '100010');
});
