import test from 'node:test';
import assert from 'node:assert/strict';
import { findInstitutionAccess, findInstitutionServices, knownInstitutionServices } from './institutionAccessService.ts';

const API = 'https://api.test';
const HOUR = 60 * 60 * 1000;

// The cache is module state that outlives each test, so every test asks about
// its own DOI or domain.
function institution(domain: string, extra = {}) {
  return { domain, rorId: null, name: domain, acronym: null, entityId: null, verifiedAt: null, ...extra };
}

/** A Worker that answers the given responses in turn, recording each URL. */
function worker(...responses: (Error | { status: number; body: unknown })[]) {
  const urls: (string | URL)[] = [];
  return {
    urls,
    request: async (url: string | URL) => {
      urls.push(url);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next!.body), { status: next!.status });
    },
  };
}

const ENTITLED = {
  status: 200,
  body: { status: 'entitled', collection: '  Elsevier ScienceDirect  ', url: 'https://eu01.alma.exlibrisgroup.com/resolve?id=1' },
};

test('asks the Worker with the DOI, the domain and the ids it has, and normalizes the answer', async () => {
  const api = worker(ENTITLED);
  const access = await findInstitutionAccess('https://doi.org/10.1000/ASK', institution('ask.es', { entityId: 'https://idp.ask.es/entity', rorId: '  ' }), { ...api, apiBase: API });

  assert.deepEqual(access, {
    status: 'entitled',
    collection: 'Elsevier ScienceDirect',
    url: 'https://eu01.alma.exlibrisgroup.com/resolve?id=1',
  });
  const url = new URL(api.urls[0]);
  assert.equal(url.origin + url.pathname, 'https://api.test/access');
  assert.equal(url.searchParams.get('doi'), '10.1000/ask');
  assert.equal(url.searchParams.get('domain'), 'ask.es');
  assert.equal(url.searchParams.get('entityId'), 'https://idp.ask.es/entity');
  assert.equal(url.searchParams.has('rorId'), false);
});

test('an entitlement without a link the browser may open is no answer, and an unknown status is refused', async () => {
  const insecure = worker({ status: 200, body: { status: 'entitled', collection: '', url: 'javascript:alert(1)' } });
  assert.equal(await findInstitutionAccess('10.1000/badurl', institution('badurl.es'), { ...insecure, apiBase: API }), null);
  const plain = worker({ status: 200, body: { status: 'entitled', collection: null, url: 'http://resolver.example/x' } });
  assert.equal(await findInstitutionAccess('10.1000/plain', institution('badurl.es'), { ...plain, apiBase: API }), null);

  const odd = worker({ status: 200, body: { status: 'maybe' } });
  assert.equal(await findInstitutionAccess('10.1000/odd', institution('badurl.es'), { ...odd, apiBase: API }), null);
});

test('keeps a definite answer for a week and an unknown one for six hours', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const definite = worker({ status: 200, body: { status: 'not-entitled', collection: null, url: null } });
  const unknown = worker({ status: 200, body: { status: 'unknown', collection: null, url: null } });
  const domain = institution('tiers.es');

  await findInstitutionAccess('10.1000/definite', domain, { ...definite, apiBase: API });
  await findInstitutionAccess('10.1000/unknown', domain, { ...unknown, apiBase: API });

  t.mock.timers.tick(6 * HOUR - 1);
  await findInstitutionAccess('10.1000/definite', domain, { ...definite, apiBase: API });
  await findInstitutionAccess('10.1000/unknown', domain, { ...unknown, apiBase: API });
  assert.equal(definite.urls.length, 1);
  assert.equal(unknown.urls.length, 1);

  t.mock.timers.tick(1);
  assert.deepEqual(
    await findInstitutionAccess('10.1000/unknown', domain, { ...unknown, apiBase: API }),
    { status: 'unknown', collection: null, url: null },
  );
  assert.equal(unknown.urls.length, 2);

  t.mock.timers.tick(7 * 24 * HOUR - 6 * HOUR - 1);
  await findInstitutionAccess('10.1000/definite', domain, { ...definite, apiBase: API });
  assert.equal(definite.urls.length, 1);
  t.mock.timers.tick(1);
  await findInstitutionAccess('10.1000/definite', domain, { ...definite, apiBase: API });
  assert.equal(definite.urls.length, 2);
});

test('the same paper asked twice at once costs one request', async () => {
  const api = worker(ENTITLED);
  const [first, second] = await Promise.all([
    findInstitutionAccess('10.1000/shared', institution('shared.es'), { ...api, apiBase: API }),
    findInstitutionAccess('10.1000/SHARED', institution('shared.es'), { ...api, apiBase: API }),
  ]);
  assert.equal(api.urls.length, 1);
  assert.equal(first!.status, 'entitled');
  assert.equal(second, first);
});

test('a domain the Worker does not support is not asked about again this session', async () => {
  const api = worker({ status: 404, body: { code: 'INSTITUTION_NOT_SUPPORTED' } });
  assert.equal(await findInstitutionAccess('10.1000/one', institution('nowhere.es'), { ...api, apiBase: API }), null);
  assert.equal(await findInstitutionAccess('10.1000/two', institution('nowhere.es'), { ...api, apiBase: API }), null);
  assert.equal(api.urls.length, 1);
});

test('failures are answered with null and asked again next time', async () => {
  const domain = institution('flaky.es');
  const failures = [
    { status: 502, body: { code: 'ACCESS_LOOKUP_UNAVAILABLE' } },
    { status: 401, body: { code: 'AUTH_REQUIRED' } },
    { status: 404, body: { code: 'NOT_FOUND' } },
    new TypeError('Failed to fetch'),
  ];
  for (const [index, failure] of failures.entries()) {
    const doi = `10.1000/flaky-${index}`;
    const api = worker(failure, ENTITLED);
    assert.equal(await findInstitutionAccess(doi, domain, { ...api, apiBase: API }), null);
    assert.equal((await findInstitutionAccess(doi, domain, { ...api, apiBase: API }))!.status, 'entitled');
    assert.equal(api.urls.length, 2);
  }
});

test('says nothing without a DOI, an institution or a Worker to ask', async () => {
  const api = worker(ENTITLED);
  assert.equal(await findInstitutionAccess('', institution('input.es'), { ...api, apiBase: API }), null);
  assert.equal(await findInstitutionAccess('arXiv:2401.00001', institution('input.es'), { ...api, apiBase: API }), null);
  assert.equal(await findInstitutionAccess('10.1000/input', null, { ...api, apiBase: API }), null);
  assert.equal(await findInstitutionAccess('10.1000/input', institution('input.es'), { ...api, apiBase: '' }), null);
  assert.equal(api.urls.length, 0);
});

const SERVICES = {
  status: 200,
  body: {
    services: [
      { id: 'sciencedirect', name: ' ScienceDirect ', publisher: 'Elsevier', url: 'https://www.sciencedirect.com/', monogram: 'SD', color: '#FF6C00', collection: 'Elsevier Freedom Collection' },
      { id: 'wiley', name: 'Wiley Online Library', publisher: '', url: 'javascript:alert(1)', monogram: 'TOOLONG', color: 'orange', collection: 'ProQuest Central', ownPlatform: false },
      { id: 'ieee', name: 'IEEE Xplore', publisher: 'IEEE', url: 'http://ieeexplore.ieee.org/', monogram: '', color: '#12345', collection: '  ' },
      { id: '', name: 'No id' },
      { id: 'noname', name: '   ' },
      'not a service',
    ],
    partial: false,
    unchecked: 3,
  },
};

function servicesAnswer(partial: boolean, unchecked?: string|number) {
  return { status: 200, body: { services: [{ id: 'jstor', name: 'JSTOR', publisher: 'ITHAKA', url: null, monogram: 'JS', color: '#990000', collection: null }], partial, unchecked } };
}

test('an unchecked count is a non-negative integer, zero when missing or malformed', async () => {
  for (const [index, [raw, expected]] of [[undefined, 0], [-2, 0], [1.5, 0], ['4', 0], [0, 0], [5, 5]].entries()) {
    const api = worker(servicesAnswer(false, raw));
    assert.equal((await findInstitutionServices(institution(`count-${index}.es`), { ...api, apiBase: API }))!.unchecked, expected);
  }
});

test('asks the Worker for the library platforms and keeps only well-formed, safe values', async () => {
  const api = worker(SERVICES);
  const answer = await findInstitutionServices(institution('Lib.ES', { rorId: 'https://ror.org/02f40zc51' }), { ...api, apiBase: API });

  assert.deepEqual(answer, {
    services: [
      { id: 'sciencedirect', name: 'ScienceDirect', publisher: 'Elsevier', url: 'https://www.sciencedirect.com/', monogram: 'SD', color: '#ff6c00', collection: 'Elsevier Freedom Collection', ownPlatform: true },
      { id: 'wiley', name: 'Wiley Online Library', publisher: null, url: null, monogram: 'W', color: null, collection: 'ProQuest Central', ownPlatform: false },
      { id: 'ieee', name: 'IEEE Xplore', publisher: 'IEEE', url: null, monogram: 'I', color: null, collection: null, ownPlatform: true },
    ],
    partial: false,
    unchecked: 3,
  });
  const url = new URL(api.urls[0]);
  assert.equal(url.origin + url.pathname, 'https://api.test/institution/services');
  assert.equal(url.searchParams.get('domain'), 'lib.es');
  assert.equal(url.searchParams.get('rorId'), 'https://ror.org/02f40zc51');
  assert.equal(url.searchParams.has('entityId'), false);
});

test('keeps a complete platform list for a week and a partial one for an hour', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const complete = worker(servicesAnswer(false));
  const partial = worker(servicesAnswer(true));

  await findInstitutionServices(institution('complete.es'), { ...complete, apiBase: API });
  assert.equal((await findInstitutionServices(institution('partial.es'), { ...partial, apiBase: API }))!.partial, true);

  t.mock.timers.tick(HOUR - 1);
  await findInstitutionServices(institution('complete.es'), { ...complete, apiBase: API });
  await findInstitutionServices(institution('partial.es'), { ...partial, apiBase: API });
  assert.equal(complete.urls.length, 1);
  assert.equal(partial.urls.length, 1);

  t.mock.timers.tick(1);
  await findInstitutionServices(institution('partial.es'), { ...partial, apiBase: API });
  assert.equal(partial.urls.length, 2);

  t.mock.timers.tick(7 * 24 * HOUR - HOUR - 1);
  await findInstitutionServices(institution('complete.es'), { ...complete, apiBase: API });
  assert.equal(complete.urls.length, 1);
  t.mock.timers.tick(1);
  await findInstitutionServices(institution('complete.es'), { ...complete, apiBase: API });
  assert.equal(complete.urls.length, 2);
});

test('a partial list is served from memory within its hour; only a failure is asked again at once', async () => {
  const partial = worker(servicesAnswer(true), servicesAnswer(false));
  await findInstitutionServices(institution('retry.es'), { ...partial, apiBase: API });
  assert.equal((await findInstitutionServices(institution('retry.es'), { ...partial, apiBase: API }))!.partial, true);
  assert.equal(partial.urls.length, 1);

  const failing = worker({ status: 502, body: { code: 'ACCESS_LOOKUP_UNAVAILABLE' } }, servicesAnswer(false));
  assert.equal(await findInstitutionServices(institution('retry-fail.es'), { ...failing, apiBase: API }), null);
  assert.equal((await findInstitutionServices(institution('retry-fail.es'), { ...failing, apiBase: API }))!.partial, false);
  assert.equal(failing.urls.length, 2);
});

test('the same library asked twice at once costs one request', async () => {
  const api = worker(servicesAnswer(false));
  const [first, second] = await Promise.all([
    findInstitutionServices(institution('together.es'), { ...api, apiBase: API }),
    findInstitutionServices(institution('TOGETHER.es'), { ...api, apiBase: API }),
  ]);
  assert.equal(api.urls.length, 1);
  assert.equal(second, first);
});

test('an answer already in hand is there without waiting; one still to ask, a failure or nothing to ask about is not', async () => {
  // The dialog paints the list on its first frame from this, instead of
  // opening on "Checking" and doubling in height mid-animation.
  assert.equal(knownInstitutionServices(institution('known.es')), undefined);
  assert.equal(knownInstitutionServices(null), undefined);
  const answer = await findInstitutionServices(institution('known.es'), { ...worker(servicesAnswer(false)), apiBase: API });
  assert.equal(knownInstitutionServices(institution('KNOWN.es')), answer);

  await findInstitutionServices(institution('known-fail.es'), { ...worker({ status: 502, body: {} }), apiBase: API });
  assert.equal(knownInstitutionServices(institution('known-fail.es')), undefined);

  await findInstitutionServices(institution('known-unsupported.es'), {
    ...worker({ status: 404, body: { code: 'INSTITUTION_NOT_SUPPORTED' } }), apiBase: API,
  });
  assert.equal(knownInstitutionServices(institution('known-unsupported.es'))!.unsupported, true);
});

test('a library the Worker cannot check is said so, not asked again, and not reported as empty-handed', async () => {
  const api = worker({ status: 404, body: { code: 'INSTITUTION_NOT_SUPPORTED' } });
  const expected = { services: [], partial: false, unsupported: true };
  assert.deepEqual(await findInstitutionServices(institution('unchecked.es'), { ...api, apiBase: API }), expected);
  assert.deepEqual(await findInstitutionServices(institution('unchecked.es'), { ...api, apiBase: API }), expected);
  assert.equal(api.urls.length, 1);
});

test('a failed platform check is null and asked again next time', async () => {
  const failures = [
    { status: 502, body: { code: 'ACCESS_LOOKUP_UNAVAILABLE' } },
    { status: 401, body: { code: 'AUTH_REQUIRED' } },
    { status: 404, body: { code: 'NOT_FOUND' } },
    { status: 200, body: { services: 'none' } },
    new TypeError('Failed to fetch'),
  ];
  for (const [index, failure] of failures.entries()) {
    const domain = institution(`down-${index}.es`);
    const api = worker(failure, servicesAnswer(false));
    assert.equal(await findInstitutionServices(domain, { ...api, apiBase: API }), null);
    assert.equal((await findInstitutionServices(domain, { ...api, apiBase: API }))!.services.length, 1);
    assert.equal(api.urls.length, 2);
  }
});


const servicesPage = (id: string, nextOffset: unknown, partial = false, unchecked = 0) => ({
  status: 200, body: { services: [{ id, name: id }], nextOffset, partial, unchecked },
});

test('follows the catalogue pages once, combines their results, and caches the whole list', async () => {
  const api = worker(servicesPage('nature', 36, false, 2), servicesPage('economist', 72, true, 1), servicesPage('hbr', null));
  const library = institution('paged.es');
  const answer = await findInstitutionServices(library, { ...api, apiBase: API });
  assert.deepEqual(answer!.services.map(service => service.id), ['nature', 'economist', 'hbr']);
  assert.equal(answer!.partial, true);
  assert.equal(answer!.unchecked, 3);
  assert.deepEqual(api.urls.map(url => new URL(url).searchParams.get('offset')), ['0', '36', '72']);
  assert.equal(await findInstitutionServices(library, { ...api, apiBase: API }), answer);
  assert.equal(api.urls.length, 3);
});

test('an unavailable later page preserves earlier results as partial, with the short cache lifetime', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const api = worker(servicesPage('economist', 36), { status: 502, body: {} }, servicesPage('guardian', null));
  const library = institution('later-failure.es');
  const answer = await findInstitutionServices(library, { ...api, apiBase: API });
  assert.deepEqual(answer!.services.map(service => service.id), ['economist']);
  assert.equal(answer!.partial, true);
  t.mock.timers.tick(HOUR + 1);
  const retry = await findInstitutionServices(library, { ...api, apiBase: API });
  assert.equal(retry!.partial, false);
  assert.deepEqual(retry!.services.map(service => service.id), ['guardian']);
});

test('malformed or repeating continuations do not start an unbounded catalogue scan', async () => {
  for (const next of [0, -1, 1.5, '36', {}, Number.MAX_SAFE_INTEGER + 1]) {
    const api = worker(servicesPage('economist', next));
    const answer = await findInstitutionServices(institution(`invalid-page-${typeof next}-${String(next).replace(/[^a-z0-9]/gi, '')}.es`), { ...api, apiBase: API });
    assert.equal(answer, null);
    assert.equal(api.urls.length, 1);
  }
  const api = worker(servicesPage('economist', 36), servicesPage('guardian', 36));
  const answer = await findInstitutionServices(institution('repeated-page.es'), { ...api, apiBase: API });
  assert.equal(answer!.partial, true);
  assert.deepEqual(answer!.services.map(service => service.id), ['economist']);
  assert.equal(api.urls.length, 2);
});

test('duplicate entries across pages are shown once and a later unsupported response preserves results', async () => {
  const api = worker(servicesPage('economist', 36), servicesPage('economist', 72), { status: 404, body: { code: 'INSTITUTION_NOT_SUPPORTED' } });
  const answer = await findInstitutionServices(institution('overlap.es'), { ...api, apiBase: API });
  assert.equal(answer!.partial, true);
  assert.equal(answer!.unsupported, undefined);
  assert.deepEqual(answer!.services.map(service => service.id), ['economist']);
});


test('journal rows retain separate ISSN identities while sharing the platform logo', async () => {
  const api = worker({ status: 200, body: { services: [
    { id: 'journal-1755-4330', name: 'Nature Chemistry', platformId: 'nature', url: 'https://library.example/journal/1755-4330' },
    { id: 'journal-1476-1122', name: 'Nature Materials', platformId: 'nature', url: 'https://library.example/journal/1476-1122' },
  ] } });
  const answer = await findInstitutionServices(institution('journal-editions.es'), { ...api, apiBase: API });
  assert.deepEqual(answer!.services.map(({ id, platformId, url }) => ({ id, platformId, url })), [
    { id: 'journal-1755-4330', platformId: 'nature', url: 'https://library.example/journal/1755-4330' },
    { id: 'journal-1476-1122', platformId: 'nature', url: 'https://library.example/journal/1476-1122' },
  ]);
});
