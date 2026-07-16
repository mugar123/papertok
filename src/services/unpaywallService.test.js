import test from 'node:test';
import assert from 'node:assert/strict';
import { mapUnpaywallResult, normalizeDoi } from './unpaywallService.js';

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
