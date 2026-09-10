import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadlineHarness.js';
import { CACHE, fetchWithTimeout, getProjectDetails } from './openAireService.js';

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
