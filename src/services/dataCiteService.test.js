import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDataCiteDirectRelations, mapDataCiteRecord } from './dataCiteService.js';

test('maps a reverse DataCite dataset relationship to a paper DOI', () => {
  const resource = mapDataCiteRecord({
    id: '10.5281/zenodo.123',
    attributes: {
      doi: '10.5281/zenodo.123',
      titles: [{ title: 'Reusable measurements' }],
      types: { resourceTypeGeneral: 'Dataset', resourceType: 'Measurements' },
      relatedIdentifiers: [{ relatedIdentifier: '10.1000/PAPER', relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo' }],
      url: 'https://zenodo.org/records/123',
      downloadCount: 42,
    },
  }, 'https://doi.org/10.1000/paper');

  assert.equal(resource.kind, 'dataset');
  assert.equal(resource.title, 'Reusable measurements');
  assert.equal(resource.downloadCount, 42);
});

test('does not map an unrelated DataCite record', () => {
  assert.equal(mapDataCiteRecord({
    id: '10.5281/zenodo.999',
    attributes: {
      doi: '10.5281/zenodo.999',
      types: { resourceTypeGeneral: 'Dataset' },
      relatedIdentifiers: [{ relatedIdentifier: '10.1000/other', relationType: 'References' }],
    },
  }, '10.1000/paper'), null);
});

test('does not treat an ordinary dataset reference as an associated resource', () => {
  assert.equal(mapDataCiteRecord({
    id: '10.5281/zenodo.998',
    attributes: {
      doi: '10.5281/zenodo.998',
      types: { resourceTypeGeneral: 'Dataset' },
      relatedIdentifiers: [{ relatedIdentifier: '10.1000/paper', relationType: 'References' }],
    },
  }, '10.1000/paper'), null);
});

test('rejects a reverse relation whose title is unrelated to the paper', () => {
  assert.equal(mapDataCiteRecord({
    id: '10.5281/zenodo.997',
    attributes: {
      doi: '10.5281/zenodo.997',
      titles: [{ title: 'Measurements of coastal erosion in Denmark' }],
      types: { resourceTypeGeneral: 'Dataset' },
      relatedIdentifiers: [{ relatedIdentifier: '10.1000/paper', relationType: 'IsSupplementTo' }],
    },
  }, '10.1000/paper', 'Room-temperature superconductivity in a carbonaceous sulfur hydride'), null);
});

test('keeps a reverse relation with a meaningful title match', () => {
  const resource = mapDataCiteRecord({
    id: '10.5281/zenodo.996',
    attributes: {
      doi: '10.5281/zenodo.996',
      titles: [{ title: 'Supporting data for room-temperature superconductivity' }],
      types: { resourceTypeGeneral: 'Dataset' },
      relatedIdentifiers: [{ relatedIdentifier: '10.1000/paper', relationType: 'IsSupplementTo' }],
    },
  }, '10.1000/paper', 'Room-temperature superconductivity in a carbonaceous sulfur hydride');

  assert.equal(resource.kind, 'dataset');
});

test('maps direct version and software relations with safe links', () => {
  const resources = mapDataCiteDirectRelations({ attributes: { relatedIdentifiers: [
    { relatedIdentifier: '10.5281/zenodo.2', relatedIdentifierType: 'DOI', relationType: 'HasVersion' },
    { relatedIdentifier: 'https://github.com/example/tool', relatedIdentifierType: 'URL', relationType: 'IsDocumentedBy', resourceTypeGeneral: 'Software' },
    { relatedIdentifier: 'https://github.com/example/compiled-tool', relatedIdentifierType: 'URL', relationType: 'IsCompiledBy', resourceTypeGeneral: 'Software' },
    { relatedIdentifier: 'javascript:alert(1)', relatedIdentifierType: 'URL', relationType: 'IsDocumentedBy', resourceTypeGeneral: 'Software' },
  ] } }, '10.5281/zenodo.1');

  assert.equal(resources.length, 3);
  assert.deepEqual(resources.map(resource => resource.kind), ['version', 'software', 'software']);
  assert.equal(resources[0].url, 'https://doi.org/10.5281/zenodo.2');
});
