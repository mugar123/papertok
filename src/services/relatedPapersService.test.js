import test from 'node:test';
import assert from 'node:assert/strict';
import { getSemanticScholarPaperId } from './relatedPapersService.js';

test('prefers DOI and normalizes provider prefixes for related papers', () => {
  assert.equal(getSemanticScholarPaperId({ doi: 'https://doi.org/10.1000/TEST', arxivId: '1234.5' }), 'DOI:10.1000/TEST');
  assert.equal(getSemanticScholarPaperId({ arxivId: '2607.12345v2' }), 'ARXIV:2607.12345');
  assert.equal(getSemanticScholarPaperId({}), null);
});

