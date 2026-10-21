import test from 'node:test';
import assert from 'node:assert/strict';
import { paperLegacyAdapter, readArxivId } from './Paper.ts';
import { areaKeyForPaper, areaLabelForPaper } from '../utils/areaAccent.ts';
import { serializeLibraryPaper } from '../utils/readingLibrary.ts';

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

test('a stored PubMed paper with a DOI keeps the id it was stored under and lands on the resolver', () => {
  const paper = paperLegacyAdapter({ id: 'pmid:31234567', title: 'T', doi: 'https://doi.org/10.1000/abc' });
  assert.equal(paper.id, 'pmid:31234567',
    'the stored id is the key its like and read mark live under; re-keying by the DOI lost them');
  assert.equal(paper.doi, '10.1000/abc');
  assert.equal(paper.arxivId, undefined);
  assert.equal(paper.landingPageUrl, 'https://doi.org/10.1000/abc');
});

test('an arXiv paper still derives its links, and keeps the id it was stored under', () => {
  const paper = paperLegacyAdapter({ id: '2401.12345', title: 'T' });
  assert.equal(paper.id, '2401.12345', 'a copy stored under the bare arXiv id stays keyed by it');
  assert.equal(paper.arxivId, '2401.12345');
  assert.equal(paper.pdfUrl, 'https://arxiv.org/pdf/2401.12345.pdf');
  assert.equal(paper.landingPageUrl, 'https://arxiv.org/abs/2401.12345');
  assert.equal(paper.sources.primary, 'arxiv');

  const legacy = paperLegacyAdapter({ id: 'hep-th/0603001', title: 'T' });
  assert.equal(legacy.id, 'hep-th/0603001');
  assert.equal(legacy.arxivId, 'hep-th/0603001');
});

test('only a copy with no id at all is keyed by its DOI or arXiv id', () => {
  assert.equal(paperLegacyAdapter({ title: 'T', doi: '10.1000/abc' }).id, '10.1000/abc');
  assert.equal(paperLegacyAdapter({ title: 'T', arxivId: '2401.12345' }).id, 'arxiv:2401.12345');
  assert.equal(paperLegacyAdapter({ id: '  ', title: 'T', doi: '10.1000/abc' }).id, '10.1000/abc', 'blank counts as none');
});

test('a stored copy keeps the branch the feed filed it under, every category, and its date', () => {
  const paper = paperLegacyAdapter(JSON.parse(JSON.stringify(serializeLibraryPaper({
    id: 'openalex:W77',
    title: 'T',
    primaryCategory: 'cond-mat.str-el',
    categories: ['cond-mat.str-el', 'cs.ET', 'q-bio.NC'],
    published: '2014-12-01',
  }))));
  assert.equal(paper.primaryCategory, 'cond-mat.str-el');
  assert.deepEqual(paper.categories, ['cond-mat.str-el', 'cs.ET', 'q-bio.NC'], 'the list used to collapse to the primary alone');
  assert.equal(paper.published, '2014-12-01');
  assert.equal(paper.year, 2014);
});

/*
 * PAP-60. Copies written before the copy kept OpenAlex's topic carry the
 * category the feed showed, and the feed showed the category it was asked
 * for: arXiv's cross-list in place of the primary (PAP-64), and the reader's
 * first choice on every Hugging Face, Europe PMC or PubMed card. Only a copy
 * of an arXiv paper, stored under its bare arXiv id with arXiv's own list,
 * still says something true: arXiv lists the primary first.
 */
test("an old copy of an arXiv paper reads as arXiv filed it, not as the category it was fetched for", () => {
  // 2605.02209 is cs.AI with a cs.LG cross-list; a feed asking for cs.LG filed it there.
  const paper = paperLegacyAdapter({ id: '2605.02209', title: 'T', primaryCategory: 'cs.LG', categories: ['cs.AI', 'cs.LG'] });
  assert.equal(paper.primaryCategory, 'cs.AI');
  assert.deepEqual(paper.categories, ['cs.AI', 'cs.LG']);
});

test('an old copy that cannot show where its category came from has no field', () => {
  const copies = {
    // Hugging Face filed every paper under the reader's first choice.
    'Hugging Face': { id: 'arxiv:2605.02209', primaryCategory: 'cs.CL', categories: ['cs.CL'] },
    // So did Europe PMC; PMID 42820985 read as Genetics or Ecology by request order.
    'Europe PMC': { id: 'pmid:42820985', primaryCategory: 'bio.gen', categories: ['bio.gen'] },
    // OpenAlex's concept names, without the topic that named the field.
    OpenAlex: { id: 'openalex:W2120490784', primaryCategory: 'Cytoplast', categories: ['Cytoplast', 'Somatic cell nuclear transfer'] },
    // The save modal's document kept only the primary, requested or not.
    'savedPapers document': { id: '2605.02209', primaryCategory: 'cs.LG', arxivId: '2605.02209' },
  };
  for (const [source, copy] of Object.entries(copies)) {
    const paper = paperLegacyAdapter({ title: 'T', ...copy });
    assert.equal(paper.primaryCategory, undefined, source);
    assert.deepEqual(paper.categories, [], source);
    assert.equal(areaKeyForPaper(paper), null, source);
    assert.equal(areaLabelForPaper(paper), null, source);
  }
});

// `savedPapers` keeps `published` and no year. A paper the feed showed with no
// date, such as a PubMed record printed next year, came back from Saved with
// the current year on it.
test('a stored copy with neither a year nor a date shows no year', () => {
  assert.equal(paperLegacyAdapter({ id: 'pmid:42879010', title: 'T' }).year, undefined);
  assert.equal(paperLegacyAdapter({ id: 'pmid:42879010', title: 'T', year: 2025 }).year, 2025);
});

test('a paper that already has the new shape passes through untouched', () => {
  const modern = { id: 'openalex:W1', sources: { primary: 'openalex', enrichedBy: [] }, title: 'T' };
  assert.equal(paperLegacyAdapter(modern), modern);
});
