import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDomainSourcePlan,
  mapBioRxivPaper,
  mapCoreWork,
  mapEuropePmcSearchResult,
  mapAdsPaper,
  mapInspirePaper,
  mapNasaRecord,
  mapOstiRecord,
} from './domainSourceService.js';

test('routes biology and engineering categories only to relevant specialist sources', () => {
  const plan = getDomainSourcePlan(['bio.cell', 'mech.aero', 'chemeng.energy', 'physics.optics']);
  assert.deepEqual(plan.biology, ['bio.cell']);
  assert.deepEqual(plan.engineering, ['mech.aero', 'chemeng.energy']);
  assert.deepEqual(plan.physics, ['physics.optics']);
  assert.deepEqual(plan.inspirePhysics, []);
  assert.deepEqual(plan.scopus, ['bio.cell', 'mech.aero', 'chemeng.energy']);
  assert.equal(plan.biorxivCategory, 'cell biology');
  assert.deepEqual(plan.osti, ['chemeng.energy']);
  assert.deepEqual(plan.nasa, ['mech.aero']);
});

test('routes high-energy physics to the INSPIRE fallback while keeping all physics eligible for ADS', () => {
  const plan = getDomainSourcePlan(['hep-ph', 'astro-ph.CO', 'cs.AI']);
  assert.deepEqual(plan.physics, ['hep-ph', 'astro-ph.CO']);
  assert.deepEqual(plan.inspirePhysics, ['hep-ph']);
});

test('maps a bioRxiv preprint without losing its selected PaperTok category', () => {
  const paper = mapBioRxivPaper({
    doi: '10.1101/2026.01.01.123456',
    version: '2',
    title: 'A cellular result',
    abstract: 'An abstract.',
    authors: 'Ada Researcher;Grace Scientist',
    date: '2026-07-08',
    category: 'Cell Biology',
    license: 'cc_by',
  }, ['bio.cell']);
  assert.equal(paper.primaryCategory, 'bio.cell');
  assert.equal(paper.publicationStatus, 'preprint');
  assert.equal(paper.openAccess, true);
  assert.equal(paper.id.includes('/'), false);
  assert.equal(paper.doi, '10.1101/2026.01.01.123456');
  assert.match(paper.pdfUrl, /\.full\.pdf$/);
  assert.match(paper.landingPageUrl, /10\.1101\/2026/);
  assert.equal(paper.authors.length, 2);
});

test('maps Europe PMC search results including free full text and biomedical terms', () => {
  const paper = mapEuropePmcSearchResult({
    id: '123',
    source: 'MED',
    pmid: '123',
    pmcid: 'PMC123',
    doi: '10.1000/BIO',
    title: 'Cell study',
    abstractText: '<b>Useful</b> abstract',
    authorList: { author: [{ fullName: 'Ada Researcher' }] },
    firstPublicationDate: '2026-01-02',
    isOpenAccess: 'N',
    fullTextUrlList: { fullTextUrl: [{ availabilityCode: 'F', documentStyle: 'pdf', url: 'https://europepmc.org/articles/PMC123?pdf=render' }] },
    keywordList: { keyword: ['Cell Biology'] },
    citedByCount: 9,
  }, ['bio.cell']);
  assert.equal(paper.doi, '10.1000/bio');
  assert.equal(paper.abstract, 'Useful abstract');
  assert.equal(paper.openAccess, true);
  assert.equal(paper.accessSource, 'europepmc');
  assert.equal(paper.citationCount, 9);
  assert.equal(paper.primaryCategory, 'bio.cell');
});

test('maps CORE, OSTI and NASA records to stable open paper records', () => {
  const core = mapCoreWork({ id: 1, title: 'Mechanical result', authors: [{ name: 'A' }], downloadUrl: 'https://core.ac.uk/download/1.pdf', yearPublished: 2025 }, ['mech.mfg']);
  const osti = mapOstiRecord({ osti_id: '2', title: 'Battery result', description: 'Energy storage', publication_date: '2026-01-01', links: [{ rel: 'fulltext', href: 'https://www.osti.gov/servlets/purl/2' }] }, ['chemeng.energy']);
  const nasa = mapNasaRecord({ id: 3, title: 'Aerodynamic result', abstract: 'Flight', publications: [{ publicationDate: '2024-01-01' }], downloads: [{ links: { pdf: '/api/citations/3/downloads/paper.pdf' } }] }, ['mech.aero']);
  assert.equal(core.primaryCategory, 'mech.mfg');
  assert.equal(core.openAccess, true);
  assert.equal(osti.primaryCategory, 'chemeng.energy');
  assert.equal(osti.openAccess, true);
  assert.equal(nasa.primaryCategory, 'mech.aero');
  assert.equal(nasa.pdfUrl, 'https://ntrs.nasa.gov/api/citations/3/downloads/paper.pdf');
});

test('maps NASA ADS records with citations, references and physics concepts', () => {
  const paper = mapAdsPaper({
    bibcode: '2026ApJ...123..456R',
    title: ['A cosmology result'],
    author: ['Researcher, Ada'],
    abstract: 'A useful result.',
    year: 2026,
    pubdate: '2026-03-00',
    doi: ['10.1000/ADS'],
    identifier: ['arXiv:2601.12345'],
    keyword: ['Cosmology'],
    arxiv_class: ['astro-ph.CO'],
    citation_count: 17,
    reference: ['2020ApJ...111..222A'],
    property: ['REFEREED', 'EPRINT_OPENACCESS'],
    pub: 'The Astrophysical Journal',
    doctype: 'article',
  }, ['astro-ph.CO']);

  assert.equal(paper.sources.primary, 'nasa-ads');
  assert.equal(paper.primaryCategory, 'astro-ph.CO');
  assert.equal(paper.arxivId, '2601.12345');
  assert.equal(paper.doi, '10.1000/ads');
  assert.equal(paper.citationCount, 17);
  assert.equal(paper.referenceCount, 1);
  assert.equal(paper.peerReviewed, true);
  assert.equal(paper.openAccess, true);
  assert.match(paper.adsUrl, /ui\.adsabs\.harvard\.edu/);
});

test('maps INSPIRE papers as a keyless high-energy physics fallback', () => {
  const paper = mapInspirePaper({
    id: '12345',
    metadata: {
      control_number: 12345,
      titles: [{ title: 'A collider result' }],
      abstracts: [{ value: 'A useful HEP result.' }],
      authors: [{ full_name: 'Researcher, Ada' }],
      arxiv_eprints: [{ value: '2602.12345' }],
      dois: [{ value: '10.1000/HEP' }],
      document_type: ['article'],
      publication_info: [{ journal_title: 'Physical Review D', year: 2026 }],
      keywords: [{ value: 'new physics' }],
      inspire_categories: [{ term: 'Phenomenology-HEP' }],
      primary_arxiv_category: ['hep-ph'],
      citation_count: 8,
      reference_count: 1,
    },
  }, ['hep-ph']);

  assert.equal(paper.sources.primary, 'inspire');
  assert.equal(paper.primaryCategory, 'hep-ph');
  assert.equal(paper.citationCount, 8);
  assert.equal(paper.citationCountKnown, true);
  assert.equal(paper.publicationStatus, 'published');
  assert.match(paper.inspireUrl, /inspirehep\.net\/literature\/12345/);
});
