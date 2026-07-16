import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeInstitutionWithRor, normalizeRorId, normalizeRorInstitution } from './rorService.js';

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
  assert.equal(institution.domains[0], 'usal.es');
  assert.equal(institution.geo.city, 'Salamanca');
  assert.equal(institution.relationships[0].rorId, '04rxrdv16');
  assert.equal(institution.rorVerified, true);
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
  assert.equal(merged.works_count, 120000);
  assert.equal(merged.summary_stats.h_index, 200);
  assert.equal(merged._metadataSource, 'openalex+ror');
});

test('normalizes full and compact ROR identifiers', () => {
  assert.equal(normalizeRorId('https://ror.org/02F40ZC51'), '02f40zc51');
  assert.equal(normalizeRorId('02f40zc51'), '02f40zc51');
  assert.equal(normalizeRorId('not-ror'), '');
});
