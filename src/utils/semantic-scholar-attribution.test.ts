import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticScholarAttribution } from './semantic-scholar-attribution.ts';

test('a record from Semantic Scholar links to its own page there', () => {
  const paper = {
    id: '649def34f8be52c8b66281af98ae884c09aef38b',
    semanticScholarId: '649def34f8be52c8b66281af98ae884c09aef38b',
    sources: { primary: 'semanticscholar', enrichedBy: [] },
  };
  assert.deepEqual(semanticScholarAttribution(paper), {
    label: 'Record from Semantic Scholar',
    href: 'https://www.semanticscholar.org/paper/649def34f8be52c8b66281af98ae884c09aef38b?utm_source=api',
  });
});

test('an abstract recovered from Semantic Scholar without an id links to its home page', () => {
  const paper = { id: 'arxiv:2401.00001', sources: { primary: 'arxiv', enrichedBy: ['openalex', 'semanticscholar'] } };
  assert.deepEqual(semanticScholarAttribution(paper), {
    label: 'Abstract from Semantic Scholar',
    href: 'https://www.semanticscholar.org/?utm_source=api',
  });
});

test('a Semantic Scholar record it also enriched is credited as the record', () => {
  const paper = { sources: { primary: 'semanticscholar', enrichedBy: ['semanticscholar'] } };
  assert.deepEqual(semanticScholarAttribution(paper), {
    label: 'Record from Semantic Scholar',
    href: 'https://www.semanticscholar.org/?utm_source=api',
  });
});

test('a paper with no Semantic Scholar data has no attribution', () => {
  assert.equal(semanticScholarAttribution({ sources: { primary: 'openalex', enrichedBy: ['crossref'] } }), null);
  assert.equal(semanticScholarAttribution({ id: 'stored-copy' }), null);
});

test('no paper has no attribution', () => {
  assert.equal(semanticScholarAttribution(null), null);
  assert.equal(semanticScholarAttribution(undefined), null);
});

test('a record under the legacy hyphenated source name is still a Semantic Scholar record', () => {
  const paper = { id: 'arxiv:2401.00002', sources: { primary: 'semantic-scholar', enrichedBy: [] } };
  assert.deepEqual(semanticScholarAttribution(paper), {
    label: 'Record from Semantic Scholar',
    href: 'https://www.semanticscholar.org/?utm_source=api',
  });
});

test('a Semantic Scholar record filed under its own hash links to its page there', () => {
  const paper = { id: '204e3073870fae3d05bcbc2f6a8e263d9b72e776', sources: { primary: 'semantic-scholar', enrichedBy: [] } };
  assert.deepEqual(semanticScholarAttribution(paper), {
    label: 'Record from Semantic Scholar',
    href: 'https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776?utm_source=api',
  });
});

test('an enriched paper whose own id looks like a hash still links to the home page', () => {
  const paper = { id: '204e3073870fae3d05bcbc2f6a8e263d9b72e776', sources: { primary: 'openalex', enrichedBy: ['semanticscholar'] } };
  assert.deepEqual(semanticScholarAttribution(paper), {
    label: 'Abstract from Semantic Scholar',
    href: 'https://www.semanticscholar.org/?utm_source=api',
  });
});

test('the hyphenated source spelling in enrichedBy is not Semantic Scholar enrichment', () => {
  assert.equal(semanticScholarAttribution({ sources: { primary: 'arxiv', enrichedBy: ['semantic-scholar'] } }), null);
});
