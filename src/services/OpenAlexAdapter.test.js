import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAlexAdapter } from './adapters/OpenAlexAdapter.js';

test('keeps OpenAlex citations and semantic concepts on discovered papers', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W123',
    title: 'An OpenAlex paper',
    type: 'article',
    cited_by_count: 42,
    concepts: [
      { id: 'https://openalex.org/C1', display_name: 'Cosmology', score: 0.91 },
      { id: 'https://openalex.org/C2', display_name: 'Weak signal', score: 0.1 },
    ],
    topics: [{ id: 'https://openalex.org/T1', display_name: 'Galaxy formation', score: 0.8 }],
    primary_topic: { id: 'https://openalex.org/T1', display_name: 'Galaxy formation' },
    authorships: [],
    open_access: { is_oa: false },
    primary_location: { is_published: true, source: { type: 'journal' } },
  });

  assert.deepEqual(paper.sources, { primary: 'openalex', enrichedBy: [] });
  assert.equal(paper.citationsCount, 42);
  assert.equal(paper.citationCountKnown, true);
  assert.deepEqual(paper.concepts.map(concept => concept.display_name), ['Cosmology']);
  assert.equal(paper.primaryTopic.display_name, 'Galaxy formation');
  assert.equal(paper.publicationStatus, 'published');
});

test('a search result hosted on arXiv carries its arXiv id', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W2626778328',
    title: 'Attention Is All You Need',
    type: 'preprint',
    cited_by_count: 6590,
    authorships: [],
    open_access: { is_oa: true, oa_url: 'https://arxiv.org/pdf/1706.03762' },
    primary_location: { is_published: false, source: { type: 'repository' } },
    locations: [{
      landing_page_url: 'http://arxiv.org/abs/1706.03762',
      pdf_url: 'https://arxiv.org/pdf/1706.03762',
      is_published: false,
    }],
  });

  assert.equal(paper.arxivId, '1706.03762');
});

test('a search result with no arXiv copy has no arXiv id to give', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W999',
    title: 'Journal-only paper',
    doi: 'https://doi.org/10.1000/journal-only',
    type: 'article',
    cited_by_count: 4,
    authorships: [],
    locations: [{ landing_page_url: 'https://example.com/journal/article', is_published: true }],
  });

  assert.equal(paper.arxivId, undefined);
});

test('does not mark repository preprints as published', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W456',
    title: 'A repository preprint',
    type: 'preprint',
    cited_by_count: 0,
    authorships: [],
    primary_location: { is_published: false, source: { type: 'repository' } },
  });

  assert.equal(paper.citationCountKnown, true);
  assert.equal(paper.publicationStatus, 'preprint');
});

test('uses current OpenAlex topics when legacy concepts are missing', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W789',
    title: 'A topic-first work',
    type: 'article',
    cited_by_count: 7,
    authorships: [],
    concepts: [],
    topics: [{ id: 'https://openalex.org/T123', display_name: 'Particle Cosmology', score: 0.87 }],
    primary_location: { is_published: true, source: { type: 'journal' } },
  });

  assert.deepEqual(paper.categories, ['Particle Cosmology']);
  assert.equal(paper.concepts[0].id, 'https://openalex.org/T123');
});
