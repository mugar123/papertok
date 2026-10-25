import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadline-harness.ts';
import {
  CACHE,
  fetchWithTimeout,
  getPapersByProject,
  getProjectDetails,
  getProjectForPaper,
  searchProjects,
} from './open-aire-service.ts';

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
        const response = await fetchWithTimeout('https://api.openaire.eu/graph/v3/projects?search=deadline', 50);
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
          'https://api.openaire.eu/graph/v3/projects?search=deadline',
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
          'https://api.openaire.eu/graph/v3/projects?search=cancelled',
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

// Captured from Graph V3 on 2026-10-23 (`/projects?id=corda__h2020::b98…` and
// `/projects?code=100010&fundingShortName=SNSF`), trimmed to two participant
// links and a shorter summary.
const TAILOR_PROJECT = {
  id: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a', code: '952215', acronym: 'TAILOR',
  title: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization',
  websiteUrl: null, startDate: '2020-09-01', endDate: '2024-08-31', callIdentifier: 'H2020-ICT-2019-3', keywords: null,
  openAccessMandateForPublications: true, openAccessMandateForDataset: true,
  subjects: ['Towards a vibrant European network of AI excellence centres'],
  fundings: [{ shortName: 'EC', name: 'European Commission', jurisdiction: 'EU', fundingStream: { id: 'EC::H2020::RIA', description: 'Horizon 2020 Framework Programme - Research and Innovation action' } }],
  summary: 'Artificial Intelligence (AI) and all the key digital technologies that are subsumed by the term AI today are an essentia',
  granted: { currency: 'EUR', totalCost: 12000000, fundedAmount: 12000000 },
  h2020Programmes: null,
  funding: {
    funder: { id: 'ec__________::EC', shortname: 'EC', name: 'European Commission', jurisdiction: { code: 'EU', label: 'European Union' }, pid: null },
    level0: { id: 'ec__________::EC::H2020', description: 'Horizon 2020 Framework Programme', name: 'H2020' },
    level1: { id: 'ec__________::EC::H2020::RIA', description: 'Research and Innovation action', name: 'RIA' },
    level2: null,
  },
  links: [
    { header: { relationClass: 'hasParticipant', relatedIdentifier: 'openorgs____::5e6bf8962665cdd040341171e5c631d8', relatedRecordType: 'organization' }, legalname: 'Delft University of Technology', legalshortname: 'TU Delft', country: { code: 'NL', label: 'Netherlands' }, websiteurl: 'http://www.tudelft.nl/' },
    { header: { relationClass: 'hasParticipant', relatedIdentifier: 'openorgs____::76681f01bcfcc1ff3405bed86eea99b2', relatedRecordType: 'organization' }, legalname: 'Fraunhofer Society', legalshortname: 'FHG', country: { code: 'DE', label: 'Germany' }, websiteurl: 'http://www.fraunhofer.de/en.html' },
  ],
};
const SNSF_PROJECT = {
  id: 'snsf________::daa28096f9e8879ab3a02b90aa0e2f83', code: '100010', acronym: null,
  title: 'Mechanistic studies of the reactions of peroxynitrite and nitrogen monoxide with heme proteins',
  websiteUrl: null, startDate: '2003-04-01', endDate: '2005-03-31', callIdentifier: null, keywords: 'Chemistry',
  openAccessMandateForPublications: false, openAccessMandateForDataset: false, subjects: null,
  fundings: [{ shortName: 'SNSF', name: 'Swiss National Science Foundation', jurisdiction: 'CH', fundingStream: { id: 'SNSF::Projects::Project funding', description: 'Projects - Project funding' } }],
  summary: null,
  granted: { currency: null, totalCost: 0, fundedAmount: 90593 },
  h2020Programmes: null,
  funding: {
    funder: { id: 'snsf________::SNSF', shortname: 'SNSF', name: 'Swiss National Science Foundation', jurisdiction: { code: 'CH', label: 'Switzerland' }, pid: null },
    level0: { id: 'snsf________::SNSF::Projects', description: 'Projects', name: 'Projects' },
    level1: { id: 'snsf________::SNSF::Projects::Project funding', description: 'Project funding', name: 'Project funding' },
    level2: null,
  },
  links: [
    { header: { relationClass: 'hasParticipant', relatedIdentifier: 'openorgs____::fb1e14f93f04d43e1a10a9f17d12c669', relatedRecordType: 'organization' }, legalname: 'ETH Zurich', legalshortname: 'ETHZ', country: { code: 'CH', label: 'Switzerland' }, websiteurl: 'https://www.ethz.ch/en.html' },
  ],
};

// Captured from `/research-products?pid=10.1145/3555174&type=publication` on
// 2026-10-23, trimmed to the fields PaperTok reads and the first project link.
const MONETIZATION_PUBLICATION = {
  id: 'doi_dedup___::0cca85815a5e054b049db70ca5a01bd7', type: 'publication',
  mainTitle: 'Characterizing Alternative Monetization Strategies on YouTube', publicationDate: '2022-11-07',
  pids: [{ scheme: 'doi', value: '10.1145/3555174' }, { scheme: 'doi', value: '10.48550/arxiv.2203.10143' }, { scheme: 'arXiv', value: '2203.10143' }],
  projects: [
    { id: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a', code: '952215', acronym: 'TAILOR', title: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization', funder: 'European Commission', pids: [{ scheme: 'doi', value: '10.3030/952215' }] },
    { id: 'nsf_________::d3a5ca6eb62ffdd1f88f75833b826ef7', code: '2120651', acronym: null, title: 'Collaborative Research: SaTC: CORE: Large: Privacy-Preserving Abuse Prevention for Encrypted Communications Platforms', funder: 'National Science Foundation', pids: null },
  ],
  links: [{
    header: { relationType: 'resultProject', relationClass: 'isProducedBy', relatedIdentifier: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a', relatedRecordType: 'project' },
    projectTitle: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization', code: '952215',
    funding: {
      funder: { id: 'ec__________::EC', shortname: 'EC', name: 'European Commission', jurisdiction: { code: 'EU', label: 'European Union' }, pid: null },
      level0: { id: 'ec__________::EC::H2020', description: 'Horizon 2020 Framework Programme', name: 'H2020' },
      level1: { id: 'ec__________::EC::H2020::RIA', description: 'Research and Innovation action', name: 'RIA' },
    },
  }],
};

/** Every request a stub saw, parsed, and the stub answering each one with `answer`. */
function graphFetch(requests: URL[], answer: (url: URL) => Response): typeof fetch {
  return async url => {
    const request = new URL(String(url));
    requests.push(request);
    return answer(request);
  };
}

test('a project page reads its details from Graph by OpenAIRE id, and a second visit from the cache', async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(graphFetch(requests, () => graphResponse([TAILOR_PROJECT])), async () => {
      const first = await getProjectDetails(TAILOR_PROJECT.id, { funder: 'EC' });
      const second = await getProjectDetails(TAILOR_PROJECT.id, { funder: 'EC' });
      assert.deepEqual(second, first, 'the same object, from the cache');
      assert.deepEqual(first, {
        id: '952215',
        openaireId: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a',
        title: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization',
        acronym: 'TAILOR',
        funder: 'EC',
        fundingStream: 'Horizon 2020 Framework Programme - Research and Innovation action',
        summary: 'Artificial Intelligence (AI) and all the key digital technologies that are subsumed by the term AI today are an essentia',
        startDate: '2020-09-01',
        endDate: '2024-08-31',
        budget: 12000000,
        fundedAmount: 12000000,
        currency: 'EUR',
        callIdentifier: 'H2020-ICT-2019-3',
        websiteUrl: null,
        subjects: ['Towards a vibrant European network of AI excellence centres'],
        participants: [
          { name: 'TU Delft', searchName: 'Delft University of Technology', country: 'Netherlands', website: 'http://www.tudelft.nl/' },
          { name: 'FHG', searchName: 'Fraunhofer Society', country: 'Germany', website: 'http://www.fraunhofer.de/en.html' },
        ],
        openAccess: true,
      }, 'no measures: Graph has no project citations, downloads or views to show');
    });
  } finally {
    CACHE.clear();
  }
  assert.equal(requests.length, 1, 'one request for two visits');
  assert.equal(`${requests[0].origin}${requests[0].pathname}`, 'https://api.openaire.eu/graph/v3/projects');
  assert.deepEqual([...requests[0].searchParams], [['id', TAILOR_PROJECT.id], ['pageSize', '1']], 'an OpenAIRE id names its funder already');
});

test("a bare grant code is asked with its funder's short name, and a currency Graph leaves null stays unknown", async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    const details = await withStubbedFetch(graphFetch(requests, () => graphResponse([SNSF_PROJECT])), () => getProjectDetails('100010', { funder: 'SNSF' }));
    assert.deepEqual([...requests[0].searchParams], [['code', '100010'], ['fundingShortName', 'SNSF'], ['pageSize', '1']]);
    assert.equal(details?.openaireId, SNSF_PROJECT.id);
    assert.equal(details?.funder, 'SNSF');
    assert.equal(details?.currency, undefined, 'not EUR: SNSF grants are not in euros');
    assert.equal(details?.budget, 90593, 'the funded amount, as the total cost is 0');
    assert.equal(details?.acronym, undefined);
    assert.equal(details?.summary, undefined);
    assert.equal(details?.openAccess, false);
    assert.deepEqual(details?.subjects, []);

    await withStubbedFetch(graphFetch(requests, () => graphResponse([])), () => getProjectDetails('100010'));
    assert.deepEqual([...requests[1].searchParams], [['code', '100010'], ['pageSize', '1']], 'no funder, no empty funder parameter');
  } finally {
    CACHE.clear();
  }
});

test('getProjectDetails does not cache a miss', async () => {
  for (const answer of [() => new Response('{}', { status: 404 }), () => graphResponse([])]) {
    let calls = 0;
    CACHE.clear();
    try {
      await withStubbedFetch(async () => { calls++; return answer(); }, async () => {
        assert.equal(await getProjectDetails('corda__h2020::00000000000000000000000000000000'), null);
        assert.equal(await getProjectDetails('corda__h2020::00000000000000000000000000000000'), null);
      });
      assert.equal(calls, 2, 'a miss is asked again — OpenAIRE indexes late');
    } finally {
      CACHE.clear();
    }
  }
});

test('a details answer in the retired Search shape is a failed lookup, not a project', async () => {
  CACHE.clear();
  try {
    const searchShaped = { response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:project': { title: { $: 'TAILOR' } } } } }] } } };
    assert.equal(await withStubbedFetch(async () => Response.json(searchShaped), () => getProjectDetails(TAILOR_PROJECT.id)), null);
    assert.equal(await withStubbedFetch(async () => graphResponse([{ ...TAILOR_PROJECT, title: null }]), () => getProjectDetails(TAILOR_PROJECT.id)), null, 'no stand-in title');
  } finally {
    CACHE.clear();
  }
});

const publications = (results: unknown[], numFound = results.length) => Response.json({ header: { numFound }, results });

test('a project lists its publications newest first, publications only, one identifier each', async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    const result = await withStubbedFetch(graphFetch(requests, () => publications([
      MONETIZATION_PUBLICATION,
      { pids: [{ scheme: 'doi', value: '10.1007/s10994-026-07033-x' }, { scheme: 'handle', value: '20.500.14243/582621' }] },
      { pids: [{ scheme: 'handle', value: '11585/952308' }] },
      { pids: null },
    ], 1428)), () => getPapersByProject(TAILOR_PROJECT.id, 2, { funder: 'EC' }));
    assert.deepEqual(result, { arxivIds: ['2203.10143'], dois: ['10.1007/s10994-026-07033-x'], total: 1428 });
  } finally {
    CACHE.clear();
  }
  assert.equal(`${requests[0].origin}${requests[0].pathname}`, 'https://api.openaire.eu/graph/v3/research-products');
  assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
    relProjectId: TAILOR_PROJECT.id, type: 'publication', sortBy: 'publicationDate DESC', page: '2', pageSize: '30',
  });
});

test('a bare grant code takes its funder into the publications query, and no funder adds none', async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(graphFetch(requests, () => publications([])), async () => {
      await getPapersByProject('100010', 1, { funder: 'SNSF' });
      await getPapersByProject('100010', 1);
    });
  } finally {
    CACHE.clear();
  }
  assert.equal(requests[0].searchParams.get('relProjectCode'), '100010');
  assert.equal(requests[0].searchParams.get('relProjectFundingShortName'), 'SNSF');
  assert.equal(requests[1].searchParams.get('relProjectCode'), '100010');
  assert.equal(requests[1].searchParams.has('relProjectFundingShortName'), false);
});

test("a page past Graph's 10,000-result window ends the list without a request, and without a total", async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(graphFetch(requests, () => publications([MONETIZATION_PUBLICATION], 20_000)), async () => {
      // The project has 20,000 publications, so 0 would be a count nobody asked for.
      assert.deepEqual(await getPapersByProject(TAILOR_PROJECT.id, 334), { arxivIds: [], dois: [], total: null });
      assert.equal(requests.length, 0, 'page 334 would start at result 10,021: Graph answers 400');
      assert.equal((await getPapersByProject(TAILOR_PROJECT.id, 333)).arxivIds.length, 1);
      assert.equal(requests[0].searchParams.get('page'), '333');
    });
  } finally {
    CACHE.clear();
  }
});

test('a rate-limited or malformed publications answer is an error, not a project with no publications', async () => {
  CACHE.clear();
  try {
    await withStubbedFetch(async () => new Response('{"message":"Too many requests"}', { status: 429, headers: { 'retry-after': '60' } }), async () => {
      await assert.rejects(getPapersByProject(TAILOR_PROJECT.id, 1), /429/);
    });
    await withStubbedFetch(async () => Response.json({ response: { header: { total: { $: '0' } }, results: null } }), async () => {
      await assert.rejects(getPapersByProject(TAILOR_PROJECT.id, 1), /Invalid OpenAIRE response/);
    });
    await withStubbedFetch(async () => publications([MONETIZATION_PUBLICATION]), async () => {
      assert.deepEqual((await getPapersByProject(TAILOR_PROJECT.id, 1)).arxivIds, ['2203.10143'], 'neither failure was cached');
    });
  } finally {
    CACHE.clear();
  }
});

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
 * The project badge on a card (issue 11c of the 2026-09-23 audit). An arXiv
 * record is filed under its OAI identifier, without the version suffix (`…v1`
 * answers nothing, measured 2026-09-24), and every answer is kept for the
 * session so a card does not pay for the same miss on every render.
 */
test('an arXiv-only paper is looked up by its OAI identifier, without the version', async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    const project = await withStubbedFetch(
      graphFetch(requests, () => publications([MONETIZATION_PUBLICATION])),
      () => getProjectForPaper('2208.08241v2', null),
    );
    assert.equal(requests.length, 1);
    assert.equal(`${requests[0].origin}${requests[0].pathname}`, 'https://api.openaire.eu/graph/v3/research-products');
    assert.deepEqual(Object.fromEntries(requests[0].searchParams), { originalId: 'oai:arXiv.org:2208.08241', type: 'publication', pageSize: '1' });
    assert.equal(project?.acronym, 'TAILOR', 'the badge can appear for a paper with no DOI');
  } finally {
    CACHE.clear();
  }
});

test("a card's project keeps its OpenAIRE id and the funder's short name, which only the publication's project link has", async () => {
  CACHE.clear();
  try {
    const project = await withStubbedFetch(async () => publications([MONETIZATION_PUBLICATION]), () => getProjectForPaper('2203.10143', '10.1145/3555174'));
    assert.deepEqual(project, {
      id: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a',
      code: '952215',
      acronym: 'TAILOR',
      title: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization',
      funder: 'EC',
      funderLevel: 'H2020',
    });
    const unlinked = await withStubbedFetch(
      async () => publications([{ ...MONETIZATION_PUBLICATION, links: [] }]),
      () => getProjectForPaper('2001.00001', null),
    );
    assert.equal(unlinked?.funder, '', 'not "European Commission": a full name in the route would not match a funder short name');
    assert.equal(unlinked?.funderLevel, '');
  } finally {
    CACHE.clear();
  }
});

test('a paper with a DOI is looked up by the DOI first, and falls back to the OAI identifier', async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    const project = await withStubbedFetch(
      graphFetch(requests, url => (url.searchParams.has('pid') ? publications([]) : publications([MONETIZATION_PUBLICATION]))),
      () => getProjectForPaper('2203.10143', '10.1145/3555174'),
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(Object.fromEntries(requests[0].searchParams), { pid: '10.1145/3555174', type: 'publication', pageSize: '1' });
    assert.equal(requests[1].searchParams.get('originalId'), 'oai:arXiv.org:2203.10143');
    assert.equal(project?.acronym, 'TAILOR');
  } finally {
    CACHE.clear();
  }
});

test('a DOI record with no project is the answer: its arXiv copy is not asked for', async () => {
  // OpenAIRE deduplicates the two into one record (10.1145/3555174 and
  // 2203.10143 answer the same doi_dedup___ id), so a second lookup would
  // return the same projectless publication.
  const requests: URL[] = [];
  CACHE.clear();
  try {
    const project = await withStubbedFetch(
      graphFetch(requests, () => publications([{ ...MONETIZATION_PUBLICATION, projects: [], links: [] }])),
      () => getProjectForPaper('2203.10143', '10.1145/3555174'),
    );
    assert.equal(project, null);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].searchParams.has('pid'));
  } finally {
    CACHE.clear();
  }
});

test('an old-style arXiv id keeps its archive prefix in the OAI identifier', async () => {
  const requests: URL[] = [];
  CACHE.clear();
  try {
    await withStubbedFetch(graphFetch(requests, () => publications([])), () => getProjectForPaper('hep-th/9901001', null));
    assert.equal(requests[0].searchParams.get('originalId'), 'oai:arXiv.org:hep-th/9901001');
  } finally {
    CACHE.clear();
  }
});

test('a card does not ask OpenAIRE twice after a refusal or a rate limit', async () => {
  for (const status of [400, 429]) {
    let calls = 0;
    CACHE.clear();
    try {
      await withStubbedFetch(async () => { calls++; return new Response('{"error":"Bad Request"}', { status }); }, async () => {
        assert.equal(await getProjectForPaper('2301.00001', null), null);
        assert.equal(await getProjectForPaper('2301.00001', null), null);
      });
      assert.equal(calls, 1, `the ${status} is remembered for the session`);
    } finally {
      CACHE.clear();
    }
  }
});

test('a card does not ask OpenAIRE twice after an empty answer', async () => {
  let calls = 0;
  CACHE.clear();
  try {
    await withStubbedFetch(async () => { calls++; return publications([]); }, async () => {
      assert.equal(await getProjectForPaper('2203.10143', '10.1145/3555174'), null);
      assert.equal(await getProjectForPaper('2203.10143', '10.1145/3555174'), null);
    });
    assert.equal(calls, 2, 'one DOI lookup and one arXiv lookup, for both calls');
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
