import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCrossrefInstitutionWork } from './crossrefInstitutionService.js';
import { isOpenAlexEnrichmentId, mapOpenAlexEnrichmentWork } from './openAlexService.js';

test('only sends arXiv and OpenAlex identifiers to batch enrichment', () => {
  assert.equal(isOpenAlexEnrichmentId('2503.10761v2'), true);
  assert.equal(isOpenAlexEnrichmentId('hep-th/9901001'), true);
  assert.equal(isOpenAlexEnrichmentId('openalex:W123'), true);
  assert.equal(isOpenAlexEnrichmentId('biorxiv:10.1101%2F2026.01.01.123456:v1'), false);
  assert.equal(isOpenAlexEnrichmentId('pmid:123456'), false);
});

test('maps real-shaped OpenAlex arXiv enrichment without a top-level id', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    doi: 'https://doi.org/10.65215/unrelated-preprint-doi',
    ids: { openalex: 'https://openalex.org/W2626778328' },
    cited_by_count: 6590,
    concepts: [{ id: 'https://openalex.org/C41008148', display_name: 'Computer science' }],
    type: 'preprint',
    open_access: { is_oa: true, oa_url: 'https://arxiv.org/pdf/1706.03762' },
    primary_location: {
      is_published: false,
      source: { type: 'repository', display_name: 'arXiv (Cornell University)' },
    },
    locations: [{
      landing_page_url: 'http://arxiv.org/abs/1706.03762',
      pdf_url: 'https://arxiv.org/pdf/1706.03762',
      is_published: false,
      source: { id: 'https://openalex.org/S4306400194' },
    }],
  });

  assert.equal(mapped.openAlexId, 'W2626778328');
  assert.equal(mapped.arxivId, '1706.03762');
  assert.equal(mapped.enrichment.citationCount, 6590);
  assert.equal(mapped.enrichment.citationCountKnown, true);
  assert.equal(mapped.enrichment.publicationType, 'preprint');
  assert.equal(mapped.enrichment.publicationStatus, 'preprint');
  assert.equal(mapped.enrichment.openAccess, true);
  assert.equal(mapped.enrichment.pdfUrl, 'https://arxiv.org/pdf/1706.03762');
  assert.equal(mapped.enrichment.doi, undefined);
});

test('keeps a published DOI while enriching an arXiv paper', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W123',
    doi: 'https://doi.org/10.1000/published-paper',
    cited_by_count: 12,
    type: 'article',
    locations: [{
      landing_page_url: 'https://arxiv.org/abs/2401.12345v2',
      is_published: true,
      source: { display_name: 'Example Journal' },
    }],
  });

  assert.equal(mapped.arxivId, '2401.12345');
  assert.equal(mapped.enrichment.doi, '10.1000/published-paper');
  assert.equal(mapped.enrichment.publicationStatus, 'published');
});

test('keeps enrichment for a native OpenAlex work without an arXiv copy', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W456',
    doi: 'https://doi.org/10.1000/openalex-only',
    cited_by_count: 24,
    type: 'article',
    locations: [],
  });

  assert.equal(mapped.openAlexId, 'W456');
  assert.equal(mapped.arxivId, '');
  assert.equal(mapped.enrichment.citationCount, 24);
  assert.equal(mapped.enrichment.doi, '10.1000/openalex-only');
});

test('falls back to current OpenAlex topics when legacy concepts are absent', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W789',
    cited_by_count: 3,
    topics: [{ id: 'https://openalex.org/T123', display_name: 'Quantum sensing', score: 0.87 }],
    primary_topic: { id: 'https://openalex.org/T123', display_name: 'Quantum sensing' },
    locations: [],
  });

  assert.equal(mapped.enrichment.concepts[0].display_name, 'Quantum sensing');
  assert.equal(mapped.enrichment.primaryTopic.id, 'https://openalex.org/T123');
});

test('maps Crossref institution fallback records into PaperTok papers', () => {
  const paper = mapCrossrefInstitutionWork({
    DOI: '10.1000/example-work',
    title: ['A study from an institutional fallback'],
    abstract: '<jats:p>Crossref <i>abstract</i>.</jats:p>',
    author: [{ given: 'Ada', family: 'Lovelace' }],
    published: { 'date-parts': [[2024, 4, 2]] },
    'container-title': ['Journal of Reliable Metadata'],
    publisher: 'Example Publisher',
    URL: 'https://doi.org/10.1000/example-work',
    'is-referenced-by-count': 18,
    type: 'journal-article',
    license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }],
  });

  assert.deepEqual(paper, {
    id: 'crossref:10.1000/example-work',
    doi: '10.1000/example-work',
    title: 'A study from an institutional fallback',
    abstract: 'Crossref abstract .',
    authors: [{ name: 'Ada Lovelace' }],
    year: 2024,
    published: '2024-04-02',
    journal: 'Journal of Reliable Metadata',
    publisher: 'Example Publisher',
    publicationType: 'journal',
    publicationStatus: 'published',
    openAccess: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    landingPageUrl: 'https://doi.org/10.1000/example-work',
    citationCount: 18,
    sourceType: 'journal-article',
    provider: 'crossref',
    sources: { primary: 'crossref', enrichedBy: [] },
  });
});
