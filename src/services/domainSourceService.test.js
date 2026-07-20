import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDomainSourcePlan,
  mapBioRxivPaper,
  mapCoreWork,
  mapEuropePmcSearchResult,
  mapNasaRecord,
  mapOstiRecord,
} from './domainSourceService.js';

test('routes biology and engineering categories only to relevant specialist sources', () => {
  const plan = getDomainSourcePlan(['bio.cell', 'mech.aero', 'chemeng.energy', 'physics.optics']);
  assert.deepEqual(plan.biology, ['bio.cell']);
  assert.deepEqual(plan.engineering, ['mech.aero', 'chemeng.energy']);
  assert.equal(plan.biorxivCategory, 'cell biology');
  assert.deepEqual(plan.osti, ['chemeng.energy']);
  assert.deepEqual(plan.nasa, ['mech.aero']);
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
