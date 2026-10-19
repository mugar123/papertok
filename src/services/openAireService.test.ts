import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadlineHarness.ts';
import {
  CACHE,
  fetchWithTimeout,
  getPapersByProject,
  getProjectDetails,
  getProjectForPaper,
  searchProjects,
} from './openAireService.ts';

test('blank project searches do not request an unfiltered project list', async () => {
  await withStubbedFetch(async () => { assert.fail('blank queries must not fetch'); }, async () => {
    assert.deepEqual(await searchProjects('   '), { projects: [], total: 0 });
  });
});

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

const emptyOpenAire = { ok: true, json: async () => ({ response: { header: { total: { $: '0' } }, results: {} } }) } as Response;
function capturingFetch(urls: string[]): typeof fetch { return async (url) => { urls.push(String(url)); return emptyOpenAire; }; }

test('un id de OpenAIRE consulta los detalles por openaireProjectID', async () => {
  const urls: string[] = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), () => getProjectDetails('snsf________::abc'));
  assert.match(urls[0], /openaireProjectID=snsf________%3A%3Aabc/);
  assert.doesNotMatch(urls[0], /grantID=/);
});

test('un código a secas lleva el funder a detalles y a publicaciones', async () => {
  const urls: string[] = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), async () => {
    await getProjectDetails('100010', { funder: 'SNSF' });
    await getPapersByProject('100010', 1, { funder: 'SNSF' });
  });
  assert.match(urls[0], /grantID=100010/); assert.match(urls[0], /funder=SNSF/);
  assert.match(urls[1], /projectID=100010/); assert.match(urls[1], /funder=SNSF/);
});

test('sin funder las URLs quedan como antes', async () => {
  const urls: string[] = [];
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
// Synthetic Graph API records use the fields observed in its live HBP response.
const hbp = { id: 'corda_______::295541e8a997d6c27aa8ce4343a7bc47', code: '284941', title: 'Human Brain Project', acronym: 'HBP', fundings: [{ shortName: 'EC' }] };
const graphResponse = (results: unknown[] = [hbp]) => Response.json({ header: { numFound: results.length }, results });

test('project title retrieval uses one Graph request and preserves canonical identity', async () => {
  const urls: URL[] = [];
  const { projects } = await withStubbedFetch(async url => {
    const request = new URL(String(url));
    urls.push(request);
    return request.pathname === '/graph/v3/projects' && request.searchParams.get('search') === '"human brain project"'
      ? graphResponse() : graphResponse([]);
  }, () => searchProjects('Human Brain Project'));
  assert.equal(urls.length, 1);
  assert.equal(projects[0]?.title, 'Human Brain Project');
  assert.equal(projects[0]?.id, hbp.id);
  assert.equal(projects[0]?.code, '284941');
  assert.equal(projects[0]?.funder, 'EC');
  assert.equal(projects[0]?.budget, undefined);
  assert.equal(projects[0]?.currency, undefined);
});

// Synthetic records reproduce the null-title and late exact-acronym rows seen live.
const tailor = { id: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a', code: '952215', acronym: 'TAILOR', title: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization' };

test('project search preserves usable rows and ranks exact acronyms beyond the old five-result window', async () => {
  const candidates = [
    { id: 'anr::incomplete', acronym: 'TAILORPACK', title: null },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `corda::${index}`, title: `Tailored materials ${index}`, acronym: `TAILOR${index}` })),
    tailor,
  ];
  for (const query of ['TAILOR', 'tailor', 'Tailor']) {
    let calls = 0;
    const result = await withStubbedFetch(async url => {
      calls++;
      const params = new URL(String(url)).searchParams;
      return graphResponse(candidates.slice(0, Number(params.get('pageSize'))));
    }, () => searchProjects(query, 1, { throwOnError: true }));
    assert.equal(calls, 1);
    assert.equal(result.projects[0]?.id, tailor.id);
    assert.equal(result.projects.length, 5);
    assert.ok(result.projects.every(project => project.id && project.title));
  }
});

test('mixed-case acronyms use acronym retrieval and preserve the original project identity', async () => {
  const project = { id: 'corda__h2020::sobigdata', acronym: 'SoBigData-PlusPlus', title: 'SoBigData++: European Integrated Infrastructure for Social Mining and Big Data Analytics' };
  let calls = 0;
  const result = await withStubbedFetch(async url => {
    calls++;
    const acronym = new URL(String(url)).searchParams.get('acronym');
    return graphResponse(acronym?.toLowerCase().includes('sobigdata-plusplus') ? [project] : []);
  }, () => searchProjects('SoBigData-PlusPlus'));
  assert.equal(result.projects[0]?.id, project.id);
  assert.equal(calls, 1);
});

test('a title typo is recovered without admitting unrelated projects or short-acronym edits', async () => {
  const requests: URL[] = [];
  const result = await withStubbedFetch(async url => {
    requests.push(new URL(String(url)));
    return requests.length === 1 ? graphResponse([]) : graphResponse([
      { ...hbp, id: 'corda::genome', title: 'Human Genome Project' },
      { ...hbp, id: 'corda::two-errors', title: 'Humor Brain Project' },
      { ...hbp, id: 'corda::long', title: 'Gateway to the Human Brain Project' }, hbp,
    ]);
  }, () => searchProjects('Human Bran Project'));
  assert.deepEqual(result.projects.map(p => p.id), [hbp.id, 'corda::long']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => url.hostname === 'api.openaire.eu'));
  assert.ok(requests[1].searchParams.get('title')?.includes('OR'));
});

test('a single-word title without an acronym gets one title lookup after a successful acronym miss', async () => {
  let calls = 0;
  const result = await withStubbedFetch(async url => {
    calls++;
    return graphResponse(new URL(String(url)).searchParams.has('title') ? [{ ...hbp, title: 'Cosmology' }] : []);
  }, () => searchProjects('Cosmology'));
  assert.equal(result.projects[0]?.title, 'Cosmology');
  assert.equal(calls, 2);
});

test('project failures never launch a recovery query', async () => {
  for (const error of [new DOMException('Timed out', 'TimeoutError'), new Error('Network failure')]) {
    let calls = 0;
    await withStubbedFetch(async () => { calls++; throw error; }, async () => {
      await assert.rejects(searchProjects('Human Bran Project', 1, { throwOnError: true }), error);
    });
    assert.equal(calls, 1);
  }
});

test('the original search deadline also stops a hanging recovery response body', async t => {
  const deadlines: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', () => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  let calls = 0;
  await withStubbedFetch(async (url, options) => {
    calls++;
    if (calls === 1) return graphResponse([]);
    const response = await dribblingFetch()(url, options);
    deadlines[0].abort(new DOMException('Search budget expired', 'TimeoutError'));
    return response;
  }, async () => {
    assert.equal(await settleWithin(500, () => searchProjects('Human Bran Project', 1, { throwOnError: true })), 'TimeoutError');
  });
  assert.equal(calls, 2);
});

test('cancellation after a successful miss prevents the recovery request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await withStubbedFetch(async () => { calls++; controller.abort(); return graphResponse([]); }, async () => {
    await assert.rejects(searchProjects('Human Bran Project', 1, { signal: controller.signal, throwOnError: true }), { name: 'AbortError' });
  });
  assert.equal(calls, 1);
});

test('numeric versions do not receive fuzzy title recovery', async () => {
  for (const query of ['Project 2025']) {
    let calls = 0;
    const result = await withStubbedFetch(async () => { calls++; return graphResponse([]); }, () => searchProjects(query));
    assert.deepEqual(result.projects, []);
    assert.equal(calls, 1);
  }
});

// Synthetic records cover provider fields and ranking independently of query construction.
test('spaced acronyms find projects whose titles do not contain the acronym', async () => {
  for (const [query, acronym] of [['ENLIGHT RISE', 'ENLIGHT RISE'], ['EGI ACE', 'EGI-ACE'], ['PRACE 6IP', 'PRACE-6IP']]) {
    const project = { id: `corda::${acronym}`, acronym, title: 'Research infrastructure collaboration' };
    let calls = 0;
    const result = await withStubbedFetch(async url => {
      calls++;
      return graphResponse(new URL(String(url)).searchParams.has('search') ? [project] : []);
    }, () => searchProjects(query));
    assert.equal(result.projects[0]?.id, project.id);
    assert.equal(calls, 1);
  }
});

test('recovery accepts a short word deletion and one error in a longer project title', async () => {
  for (const [query, title] of [
    ['Human Cel Atlas', 'Human Cell Atlas of the Pancreas'],
    ['Fostering FAIR Data Practcies in Europe', 'Fostering FAIR Data Practices in Europe'],
  ]) {
    let calls = 0;
    const result = await withStubbedFetch(async () => {
      calls++;
      return graphResponse(calls === 1 ? [] : [
        { id: 'target', title },
        { id: 'wrong', title: 'Human Genome Atlas' },
      ]);
    }, () => searchProjects(query));
    assert.deepEqual(result.projects.map(project => project.id), ['target']);
    assert.equal(calls, 2);
  }
});

test('a final-word typo retains a phrase prefix to retrieve crowded project candidates', async () => {
  const result = await withStubbedFetch(async url => {
    const title = new URL(String(url)).searchParams.get('title');
    return graphResponse(title?.includes('"human cell at"')
      ? [{ id: 'pancreas', title: 'Human Cell Atlas of the Pancreas' }] : []);
  }, () => searchProjects('Human Cell Atals'));
  assert.equal(result.projects[0]?.id, 'pancreas');
});

test('acronym typo recovery rejects unrelated fragments and keeps numeric versions distinct', async () => {
  for (const [query, acronym] of [['FAIRsFIAR', 'FAIRsFAIR'], ['AI4UE', 'AI4EU']]) {
    let calls = 0;
    const result = await withStubbedFetch(async () => {
      calls++;
      return graphResponse(calls < 3 ? [] : [
        { id: 'target', acronym, title: 'Research infrastructure' },
        { id: 'wrong', acronym: 'AI5EU', title: 'Another infrastructure' },
        { id: 'fragment', acronym: 'FAIRSHARE', title: 'Shared infrastructure' },
      ]);
    }, () => searchProjects(query));
    assert.deepEqual(result.projects.map(project => project.id), ['target']);
    assert.equal(calls, 3);
  }
});

test('short acronym transpositions retrieve exact alternatives without changing digits', async () => {
  for (const [query, acronym] of [['CINEAC', 'CINECA'], ['AI4UE', 'AI4EU'], ['TAILRO', 'TAILOR']]) {
    let calls = 0;
    const result = await withStubbedFetch(async url => {
      calls++;
      const expression = new URL(String(url)).searchParams.get('acronym');
      return graphResponse(expression?.includes(JSON.stringify(acronym.toLowerCase()))
        ? [{ id: 'target', acronym, title: 'A research collaboration' }] : []);
    }, () => searchProjects(query));
    assert.equal(result.projects[0]?.id, 'target');
    assert.equal(calls, 3);
  }
});

test('recovery does not turn a changed numeric version or a two-letter fragment into a typo match', async () => {
  for (const [query, project] of [
    ['AI5EU', { id: 'wrong-version', acronym: 'AI4EU', title: 'A research infrastructure' }],
    ['Human Ce Atlas', { id: 'too-short', title: 'Human Cell Atlas' }],
  ] as const) {
    let calls = 0;
    const result = await withStubbedFetch(async () => {
      calls++;
      return graphResponse(calls === 1 ? [] : [project]);
    }, () => searchProjects(query));
    assert.deepEqual(result.projects, []);
  }
});

test('an error in the title fallback never launches an acronym recovery', async () => {
  let calls = 0;
  await withStubbedFetch(async () => {
    calls++;
    return calls === 1 ? graphResponse([]) : new Response('', { status: 503 });
  }, async () => {
    await assert.rejects(searchProjects('CINEAC', 1, { throwOnError: true }), /503/);
  });
  assert.equal(calls, 2);
});

test('project acronym lookup stays a single request', async () => {
  const urls: URL[] = [];
  await withStubbedFetch(async url => {
    urls.push(new URL(String(url)));
    return graphResponse();
  }, () => searchProjects('HBP'));
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get('acronym'), '"hbp"');
});

test('Graph project validation rejects malformed results instead of inventing identities or empty success', async () => {
  for (const payload of [{}, { results: [] }, { header: { numFound: 1 }, results: [{ code: '284941', title: 'Human Brain Project' }] }]) {
    await withStubbedFetch(async () => Response.json(payload), async () => {
      await assert.rejects(searchProjects('Human Brain Project', 1, { throwOnError: true }), /OpenAIRE/);
    });
  }
});

test('distinct canonical grants sharing a title stay separate and unknown currency stays unknown', async () => {
  const { projects } = await withStubbedFetch(async () => graphResponse([
    { ...hbp, granted: { totalCost: 0, fundedAmount: 42, currency: null } },
    { ...hbp, id: 'corda_______::second-grant', granted: { totalCost: 0, fundedAmount: 0, currency: 'EUR' } },
  ]), () => searchProjects('Human Brain Project'));
  assert.equal(projects.length, 2);
  assert.equal(projects[0].budget, 42);
  assert.equal(projects[0].currency, undefined);
  assert.equal(projects[1].budget, 0);
  assert.equal(projects[1].currency, 'EUR');
});

function installProjectCache(t: import('node:test').TestContext) {
  const storage = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
}

test('successful project search survives a later outage through persistent cache, then refreshes after expiry', async t => {
  installProjectCache(t);
  let calls = 0;
  await withStubbedFetch(async () => { calls++; return graphResponse(); }, async () => {
    const result = await searchProjects('Human Brain Project');
    assert.equal(result.projects[0].id, hbp.id);
  });
  await withStubbedFetch(async () => { calls++; throw new DOMException('Provider timed out', 'TimeoutError'); }, async () => {
    const result = await searchProjects(' Human Brain Project ');
    assert.equal(result.projects[0].id, hbp.id);
    assert.equal(calls, 1, 'the persistent cache answers without contacting the unavailable provider');
    await assert.rejects(searchProjects('Human Brain Project', 2, { throwOnError: true }), { name: 'TimeoutError' });
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(searchProjects('Human Brain Project', 1, { signal: cancellation.signal, throwOnError: true }), { name: 'AbortError' });
  });
  const nextDay = Date.now() + 25 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => nextDay);
  await withStubbedFetch(async () => { calls++; return graphResponse([{ ...hbp, title: 'Human Brain Project updated' }]); }, async () => {
    assert.equal((await searchProjects('Human Brain Project')).projects[0].title, 'Human Brain Project updated');
    assert.equal(calls, 3, 'expired data requires a new request, without a retry or fallback query');
  });
});

test('project errors and successful empty answers remain retryable', async t => {
  installProjectCache(t);
  let calls = 0;
  await withStubbedFetch(async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 503 });
    return calls <= 3 ? graphResponse([]) : graphResponse();
  }, async () => {
    await assert.rejects(searchProjects('Human Brain Project', 1, { throwOnError: true }), /503/);
    assert.deepEqual(await searchProjects('Human Brain Project'), { projects: [], total: 0 });
    assert.equal((await searchProjects('Human Brain Project')).projects[0].id, hbp.id);
    assert.equal(calls, 4);
  });
});

/**
 * The project badge on a card (issue 11c of the 2026-09-23 audit). OpenAIRE
 * has no `pid` parameter: every arXiv-only card spent a request on a 400
 * «Parameter pid is not supported», uncached, so the badge could never appear
 * for a paper with no DOI and the failure was paid again on every render. The
 * record is filed under its OAI identifier, without the version suffix
 * (`…v1` answers nothing, measured 2026-09-24).
 */
const TAILOR_RELATION = {
  to: {
    '@class': 'isProducedBy',
    '@scheme': 'dnet:result_project_relations',
    '@type': 'project',
    $: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a',
  },
  code: { $: '952215' },
  acronym: { $: 'TAILOR' },
  title: { $: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization' },
  funding: {
    funder: { '@id': 'ec__________::EC', '@shortname': 'EC', '@name': 'European Commission', '@jurisdiction': 'EU' },
    funding_level_0: { '@name': 'H2020', $: 'ec__________::EC::H2020' },
  },
};

function publicationAnswer(rels: { to: { '@class': string; '@scheme': string; '@type': string; $: string; }; code: { $: string; }; acronym: { $: string; }; title: { $: string; }; funding: { funder: { '@id': string; '@shortname': string; '@name': string; '@jurisdiction': string; }; funding_level_0: { '@name': string; $: string; }; }; }[]) {
  return new Response(JSON.stringify({
    response: {
      header: { total: { $: 1 } },
      results: { result: [{ metadata: { 'oaf:entity': { 'oaf:result': { rels: { rel: rels } } } } }] },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The shape OpenAIRE sends when nothing matches: `results` is null.
function emptyPublicationAnswer() {
  return new Response(JSON.stringify({ response: { header: { total: { $: '0' } }, results: null } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function recordingFetch(urls: string[], answer: (url: string) => Response): typeof fetch {
  return async (url) => {
    urls.push(String(url));
    return answer(String(url));
  };
}

test('an arXiv-only paper is looked up by its OAI identifier, without the version', async () => {
  const urls: string[] = [];
  CACHE.clear();
  try {
    const project = await withStubbedFetch(
      recordingFetch(urls, () => publicationAnswer([TAILOR_RELATION])),
      () => getProjectForPaper('2208.08241v2', null),
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0], /[?&]originalId=oai%3AarXiv\.org%3A2208\.08241(&|$)/);
    assert.doesNotMatch(urls[0], /[?&]pid=/);
    assert.equal(project?.acronym, 'TAILOR', 'the badge can now appear for a paper with no DOI');
    assert.equal(project?.funder, 'EC');
  } finally {
    CACHE.clear();
  }
});

test('a paper with a DOI is looked up by the DOI first, and falls back to the OAI identifier', async () => {
  const urls: string[] = [];
  CACHE.clear();
  try {
    const project = await withStubbedFetch(
      recordingFetch(urls, (url: string) => (url.includes('doi=') ? emptyPublicationAnswer() : publicationAnswer([TAILOR_RELATION]))),
      () => getProjectForPaper('2203.10143', '10.1145/3555174'),
    );
    assert.equal(urls.length, 2);
    assert.match(urls[0], /[?&]doi=10\.1145%2F3555174(&|$)/);
    assert.doesNotMatch(urls[0], /originalId=/);
    assert.match(urls[1], /[?&]originalId=oai%3AarXiv\.org%3A2203\.10143(&|$)/);
    assert.equal(project?.acronym, 'TAILOR');
  } finally {
    CACHE.clear();
  }
});

test('a DOI record with no project is the answer: its arXiv copy is not asked for', async () => {
  // OpenAIRE deduplicates the two into one record (10.1145/3555174 and
  // 2203.10143 answer the same doi_dedup___ id), so a second lookup would
  // return the same projectless publication.
  const urls: string[] = [];
  CACHE.clear();
  try {
    const project = await withStubbedFetch(
      recordingFetch(urls, () => publicationAnswer([])),
      () => getProjectForPaper('2203.10143', '10.1145/3555174'),
    );
    assert.equal(project, null);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /[?&]doi=/);
  } finally {
    CACHE.clear();
  }
});

test('an old-style arXiv id keeps its archive prefix in the OAI identifier', async () => {
  const urls: string[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(
      recordingFetch(urls, () => emptyPublicationAnswer()),
      () => getProjectForPaper('hep-th/9901001', null),
    );
    assert.match(urls[0], /[?&]originalId=oai%3AarXiv\.org%3Ahep-th%2F9901001(&|$)/);
  } finally {
    CACHE.clear();
  }
});

test('a card does not ask OpenAIRE twice after a refusal', async () => {
  const urls: string[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(
      recordingFetch(urls, () => new Response('{"status":"error","code":"400"}', { status: 400 })),
      async () => {
        assert.equal(await getProjectForPaper('2301.00001', null), null);
        assert.equal(await getProjectForPaper('2301.00001', null), null);
      },
    );
    assert.equal(urls.length, 1, 'the refusal is remembered for the session');
  } finally {
    CACHE.clear();
  }
});

test('a card does not ask OpenAIRE twice after an empty answer', async () => {
  const urls: string[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(
      recordingFetch(urls, () => emptyPublicationAnswer()),
      async () => {
        assert.equal(await getProjectForPaper('2203.10143', '10.1145/3555174'), null);
        assert.equal(await getProjectForPaper('2203.10143', '10.1145/3555174'), null);
      },
    );
    assert.equal(urls.length, 2, 'one DOI lookup and one arXiv lookup, for both calls');
  } finally {
    CACHE.clear();
  }
});

test('a card does not ask OpenAIRE twice after a network failure', async () => {
  let calls = 0;
  CACHE.clear();
  try {
    await withStubbedFetch(
      async () => { calls++; throw new TypeError('Failed to fetch'); },
      async () => {
        assert.equal(await getProjectForPaper(null!, '10.1145/3555174'), null);
        assert.equal(await getProjectForPaper(null!, '10.1145/3555174'), null);
      },
    );
    assert.equal(calls, 1);
  } finally {
    CACHE.clear();
  }
});
