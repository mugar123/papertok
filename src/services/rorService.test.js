import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadlineHarness.js';
import {
  fetchJson,
  mergeInstitutionWithRor,
  normalizeRorId,
  normalizeRorInstitution,
  searchRorInstitutions,
} from './rorService.js';

const ROR_RECORD = {
  id: 'https://ror.org/02f40zc51',
  names: [
    { value: 'USAL', types: ['acronym'] },
    { value: 'Universidad de Salamanca', lang: 'es', types: ['ror_display', 'label'] },
    { value: 'University of Salamanca', lang: 'en', types: ['label'] },
  ],
  domains: ['usal.es'],
  established: 1134,
  links: [
    { type: 'website', value: 'https://www.usal.es' },
    { type: 'wikipedia', value: 'https://en.wikipedia.org/wiki/University_of_Salamanca' },
  ],
  locations: [{ geonames_details: { name: 'Salamanca', country_name: 'Spain', country_code: 'ES', lat: 40.9, lng: -5.6 } }],
  relationships: [{ id: 'https://ror.org/04rxrdv16', label: 'Centro de Investigación del Cáncer', type: 'child' }],
  status: 'active',
  types: ['education', 'funder'],
};

test('normalizes ROR v2 institutional metadata', () => {
  const institution = normalizeRorInstitution(ROR_RECORD);
  assert.equal(institution.display_name, 'Universidad de Salamanca');
  assert.deepEqual(institution.localized_names, {
    es: 'Universidad de Salamanca',
    en: 'University of Salamanca',
  });
  assert.equal(institution.domains[0], 'usal.es');
  assert.equal(institution.geo.city, 'Salamanca');
  assert.equal(institution.relationships[0].rorId, '04rxrdv16');
  assert.equal(institution.rorVerified, true);
});

// ROR guarda los enlaces tal como los declaró la institución, y una parte de
// ellos sigue registrada en claro. El Explorer pasa `homepage_url` por
// `safeExternalUrl` y solo pinta la fila si sobrevive, así que ahí el enlace no
// quedaba muerto: «Web oficial» desaparecía sin dejar rastro.
test('sube a HTTPS los enlaces que ROR entrega en claro', () => {
  const institution = normalizeRorInstitution({
    ...ROR_RECORD,
    links: [
      { type: 'website', value: 'http://www.usal.es' },
      { type: 'wikipedia', value: 'http://es.wikipedia.org/wiki/Universidad_de_Salamanca' },
    ],
  });

  assert.equal(institution.homepage_url, 'https://www.usal.es/');
  assert.equal(institution.wikipedia_url, 'https://es.wikipedia.org/wiki/Universidad_de_Salamanca');
});

test('merges ROR identity without losing OpenAlex metrics', () => {
  const ror = normalizeRorInstitution(ROR_RECORD);
  const merged = mergeInstitutionWithRor({
    id: 'https://openalex.org/I123',
    display_name: 'University of Salamanca',
    works_count: 120000,
    cited_by_count: 4500000,
    summary_stats: { h_index: 200 },
  }, ror);
  assert.equal(merged.id, 'https://openalex.org/I123');
  assert.equal(merged.display_name, 'Universidad de Salamanca');
  assert.equal(merged.localized_names.en, 'University of Salamanca');
  assert.equal(merged.works_count, 120000);
  assert.equal(merged.summary_stats.h_index, 200);
  assert.equal(merged._metadataSource, 'openalex+ror');
});

test('normalizes full and compact ROR identifiers', () => {
  assert.equal(normalizeRorId('https://ror.org/02F40ZC51'), '02f40zc51');
  assert.equal(normalizeRorId('02f40zc51'), '02f40zc51');
  assert.equal(normalizeRorId('not-ror'), '');
});

test('caches repeated institution searches in memory', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: [ROR_RECORD] }),
    };
  };

  try {
    const first = await searchRorInstitutions('Universidad de Salamanca', 5);
    const second = await searchRorInstitutions('Universidad de Salamanca', 5);

    assert.equal(fetchCount, 1);
    assert.equal(first[0].display_name, 'Universidad de Salamanca');
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the deadline covers a ROR body that never finishes', async () => {
  // Before the fix this cleared its timer as soon as the headers landed, so a
  // dribbling body waited for ever behind a seven-second deadline.
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, () => fetchJson('https://api.ror.org/v2/organizations?query=deadline', 50)),
      'TimeoutError',
    );
  });
});

test('a caller signal does not take the ROR deadline away with it', async () => {
  // `SearchPage` passes an abort signal on every keystroke. Under a `??` rule
  // that signal would have replaced the deadline and left the typeahead — the
  // busiest path this service has — unbounded again.
  const cancellation = new AbortController();
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, () => fetchJson(
        'https://api.ror.org/v2/organizations?query=deadline-with-signal',
        50,
        { signal: cancellation.signal },
      )),
      'TimeoutError',
    );
  });
});
