import test from 'node:test';
import assert from 'node:assert/strict';
import { paperLegacyAdapter, readArxivId } from './Paper.js';

/**
 * The stored copies of papers — a list entry, a library record — reach the
 * screens through this adapter, and it used to take ANY bare `id` for an arXiv
 * id. A paper saved from an OpenAlex card came out with an arXiv PDF that did
 * not exist and a canonical id (`arxiv:openalex:W…`) no public paper key could
 * read, so clicking it in a list opened a broken PDF instead of the paper page.
 */
test('reads an arXiv id in every shape it is stored in, and nothing else', () => {
  assert.equal(readArxivId('2401.12345v2'), '2401.12345v2');
  assert.equal(readArxivId('hep-th/0603001'), 'hep-th/0603001');
  assert.equal(readArxivId('arxiv:2401.12345'), '2401.12345');
  assert.equal(readArxivId('https://arxiv.org/abs/2401.12345v1'), '2401.12345v1');
  assert.equal(readArxivId('http://arxiv.org/pdf/2401.12345.pdf'), '2401.12345');
  assert.equal(readArxivId('openalex:W2741809807'), '');
  assert.equal(readArxivId('pmid:31234567'), '');
  assert.equal(readArxivId('10.7717/peerj.4375'), '');
  assert.equal(readArxivId('649def34f8be52c8b66281af98ae884c09aef38b'), '');
  assert.equal(readArxivId(''), '');
});

test('a stored OpenAlex paper keeps its id and gets no arXiv links', () => {
  const paper = paperLegacyAdapter({
    id: 'openalex:W2741809807',
    title: 'The state of OA',
    summary: 'Despite growing interest…',
    landingPageUrl: 'https://peerj.com/articles/4375',
  });
  assert.equal(paper.id, 'openalex:W2741809807');
  assert.equal(paper.arxivId, undefined);
  assert.equal(paper.pdfUrl, undefined, 'no PDF was stored, so none is invented');
  assert.equal(paper.landingPageUrl, 'https://peerj.com/articles/4375', 'the stored landing page survives');
  assert.equal(paper.sources.primary, 'stored');
});

test('a stored PubMed paper with a DOI is keyed by the DOI and lands on the resolver', () => {
  const paper = paperLegacyAdapter({ id: 'pmid:31234567', title: 'T', doi: 'https://doi.org/10.1000/abc' });
  assert.equal(paper.id, '10.1000/abc');
  assert.equal(paper.doi, '10.1000/abc');
  assert.equal(paper.arxivId, undefined);
  assert.equal(paper.landingPageUrl, 'https://doi.org/10.1000/abc');
});

test('an arXiv paper still derives its links and canonical id as before', () => {
  const paper = paperLegacyAdapter({ id: '2401.12345', title: 'T' });
  assert.equal(paper.id, 'arxiv:2401.12345');
  assert.equal(paper.arxivId, '2401.12345');
  assert.equal(paper.pdfUrl, 'https://arxiv.org/pdf/2401.12345.pdf');
  assert.equal(paper.landingPageUrl, 'https://arxiv.org/abs/2401.12345');
  assert.equal(paper.sources.primary, 'arxiv');

  const legacy = paperLegacyAdapter({ id: 'hep-th/0603001', title: 'T' });
  assert.equal(legacy.id, 'arxiv:0603001', 'the canonical id keeps its historical shape');
  assert.equal(legacy.arxivId, 'hep-th/0603001');
});

test('a paper that already has the new shape passes through untouched', () => {
  const modern = { id: 'openalex:W1', sources: { primary: 'openalex', enrichedBy: [] }, title: 'T' };
  assert.equal(paperLegacyAdapter(modern), modern);
});
