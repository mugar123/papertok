import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Paper } from '../models/paper.ts';
import {
  reportDomainSourceFailures,
  settleDomainSources,
} from './domain-source-service.ts';
import {
  getDomainSourcePlan,
  getEligibleDomainSources,
  mapBioRxivPaper,
  mapCoreWork,
  mapEuropePmcSearchResult,
  mapAdsPaper,
  mapInspirePaper,
  mapNasaRecord,
  mapOstiRecord,
  readBioRxivResponse,
  europePmcQuery,
} from './domain-source-records.ts';
import { PaperBuilder } from './paper-builder.ts';
import { isFeedPublication } from './feed-publication-rules.ts';
import { scorePaperForRecommendation } from '../utils/recommendation-engine.ts';
import { areaAccentForPaper, areaKeyForPaper, areaLabelForPaper } from '../utils/area-accent.ts';
import { paperLegacyAdapter } from '../models/paper.ts';
import { serializeLibraryPaper } from '../utils/reading-library.ts';
import { buildSavedPaperPayload } from '../utils/saved-paper-payload.ts';

// The Worker answers a bioRxiv outage with an empty collection marked
// `_papertok.degraded` (cached briefly). Read as papers it would be "bioRxiv has
// nothing", and the source's health log would stay silent through an outage.
test('a degraded bioRxiv answer is a source failure, not an empty result', () => {
  assert.throws(
    () => readBioRxivResponse({ collection: [], _papertok: { degraded: 'UPSTREAM_TIMEOUT' } }, ['bio.neuro'], 10),
    (error) => (error as Error & { code?: string; status?: number; retryAfterMs?: number }).code === 'UPSTREAM_TIMEOUT',
  );
  assert.deepEqual(readBioRxivResponse({ messages: [{ status: 'no posts found' }], collection: [] } as NonNullable<Parameters<typeof readBioRxivResponse>[0]> & Record<string, unknown>, ['bio.neuro'], 10), []);
  const papers = readBioRxivResponse({
    collection: [{ doi: '10.1101/2026.09.01.000001', title: 'A preprint', authors: 'Doe, J.', date: '2026-09-01', category: 'neuroscience', version: '1' }],
  }, ['bio.neuro'], 10);
  assert.equal(papers.length, 1);
});
// Shared with `fetchWorkerSourceJson`, so it lives in the module both source
// entry points can import without closing a cycle.
import { sourceResponseError } from './worker-api-client.ts';

test('records without a publication date keep the year unknown', () => {
  const papers = [
    mapBioRxivPaper({ doi: '10.1101/2024.01.01.000001', title: 'Undated preprint', abstract: 'A.', authors: 'Ada', category: 'neuroscience' }),
    mapOstiRecord({ osti_id: '1', title: 'Undated report', description: 'A.', doi: '10.2172/1' }),
    mapCoreWork({ id: '1', title: 'Undated core', abstract: 'A.', doi: '10.1000/core' }),
    mapAdsPaper({ bibcode: '2024xxxx.1A', title: ['Undated ADS'], abstract: 'A.', doi: ['10.1000/ads'] }),
    mapInspirePaper({ control_number: 7, titles: [{ title: 'Undated INSPIRE' }], abstracts: [{ value: 'A.' }], dois: [{ value: '10.1000/ins' }] }),
    mapEuropePmcSearchResult({ id: '1', pmid: '1', source: 'MED', title: 'Undated Europe PMC' }),
    mapNasaRecord({ id: 1, title: 'Undated NASA', abstract: 'A.' }),
  ];
  for (const paper of papers) {
    assert.ok(paper, 'record maps');
    assert.equal(paper.year, undefined, paper.id);
    assert.equal(/^\d{4}-01-01$/.test(String(paper.published || '')), false, `${paper.id} has no invented date`);
  }
});

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
  assert.deepEqual(plan.openReview, []);
  assert.deepEqual(plan.huggingFace, []);
});

test('routes high-energy physics to the INSPIRE fallback while keeping all physics eligible for ADS', () => {
  const plan = getDomainSourcePlan(['hep-ph', 'astro-ph.CO', 'cs.AI']);
  assert.deepEqual(plan.physics, ['hep-ph', 'astro-ph.CO']);
  assert.deepEqual(plan.inspirePhysics, ['hep-ph']);
  assert.deepEqual(plan.openReview, ['cs.AI']);
  assert.deepEqual(plan.huggingFace, ['cs.AI']);
});

test('maps a bioRxiv preprint under the subject bioRxiv files it in', () => {
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
  assert.equal(paper!.primaryCategory, 'bio.cell');
  assert.equal(paper!.publicationStatus, 'preprint');
  assert.equal(paper!.openAccess, true);
  assert.equal(paper!.id.includes('/'), false);
  assert.equal(paper!.doi, '10.1101/2026.01.01.123456');
  assert.match(paper!.pdfUrl!, /\.full\.pdf$/);
  assert.match(paper!.landingPageUrl!, /10\.1101\/2026/);
  assert.equal(paper!.authors.length, 2);
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
  assert.equal(paper!.doi, '10.1000/bio');
  assert.equal(paper!.abstract, 'Useful abstract');
  assert.equal(paper!.openAccess, true);
  assert.equal(paper!.accessSource, 'europepmc');
  assert.equal(paper!.citationCount, 9);
  // An author keyword, not Europe PMC filing the paper under Cell Biology; the
  // request is only why it was fetched.
  assert.deepEqual(paper!.categories, ['Cell Biology']);
  assert.deepEqual(paper!._fetchedFor, ['bio.cell']);
});

// An unfielded `"Molecular Biology"` also matches the journal name, and
// 139 records in the 2026-10-20 audit were chapters of Methods in Molecular
// Biology dated 2027. The labels are searched where a paper states its
// subject, and nothing dated after today comes back.
test('the Europe PMC request searches each label in title, abstract and keywords, up to today', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T15:00:00Z') });
  const query = europePmcQuery(['bio.gen', 'bio.mol']);

  for (const label of ['Genetics', 'Molecular Biology']) {
    assert.ok(query.includes(`TITLE_ABS:"${label}"`), `${label} in title and abstract: ${query}`);
    assert.ok(query.includes(`KW:"${label}"`), `${label} in keywords: ${query}`);
  }
  const fields = [...query.matchAll(/(\w+:)?"[^"]*"/g)].map(([, field]) => field);
  assert.deepEqual([...new Set(fields)].sort(), ['KW:', 'TITLE_ABS:'], `no label is searched in every field: ${query}`);
  assert.match(query, /\bAND FIRST_PDATE:\[\S+ TO 2026-10-20\]$/);
});

// Captured from Europe PMC on 2026-10-20 (PMID 42879010), trimmed to the
// fields the mapper reads.
const PROTOCOL_CHAPTER = {
  id: '42879010',
  source: 'MED',
  pmid: '42879010',
  doi: '10.1007/978-1-0716-5587-0_5',
  title: '(Immuno-)Histological Analysis of Ewing Sarcoma.',
  authorString: 'Marcilla D, Machado I, Grünewald TGP, Civantos G, Llombart-Bosch A, de Álava E.',
  journalInfo: {
    yearOfPublication: 2027,
    journal: { title: 'Methods in molecular biology (Clifton, N.J.)', essn: '1940-6029', issn: '1064-3745', nlmid: '9214969' },
  },
  pubTypeList: { pubType: ['Journal Article'] },
  abstractText: 'The diagnosis of Ewing sarcoma requires integrating information from numerous techniques.',
  dateOfCreation: '2026-10-15',
  firstPublicationDate: '2027-01-01',
};

test('a Methods in Molecular Biology chapter from Europe PMC is typed as a book-series chapter, which the feed leaves out', () => {
  const chapter = PaperBuilder.deduplicate([mapEuropePmcSearchResult(PROTOCOL_CHAPTER, ['bio.mol'])])[0];
  assert.equal(chapter.publicationType, 'book-chapter');
  assert.equal(isFeedPublication(chapter), false);

  for (const journal of [{ issn: '1064-3745' }, { essn: '1940-6029' }, { nlmid: '9214969' }]) {
    const paper = mapEuropePmcSearchResult({ ...PROTOCOL_CHAPTER, journalInfo: { journal } }, ['bio.mol']);
    assert.equal(isFeedPublication(paper!), false, `identified by ${Object.keys(journal)[0]} alone`);
  }

  const article = mapEuropePmcSearchResult({
    ...PROTOCOL_CHAPTER,
    journalInfo: { journal: { title: 'Nature', issn: '0028-0836', essn: '1476-4687', nlmid: '0410462' } },
  }, ['bio.mol']);
  assert.equal(article!.publicationType, 'article');
  assert.equal(isFeedPublication(article!), true);
});

test('a Europe PMC record dated after today shows no year and no date', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T15:00:00Z') });
  const scheduled = PaperBuilder.deduplicate([mapEuropePmcSearchResult(PROTOCOL_CHAPTER, ['bio.mol'])])[0];
  assert.equal(scheduled.year, undefined, 'not 2027, and not the 2026 the record was created in');
  assert.equal(scheduled.published, '');

  const yearOnly = mapEuropePmcSearchResult({ ...PROTOCOL_CHAPTER, firstPublicationDate: undefined, dateOfCreation: undefined }, ['bio.mol']);
  assert.equal(yearOnly!.year, undefined, 'a publication year of 2027 is after today too');

  const current = mapEuropePmcSearchResult({ ...PROTOCOL_CHAPTER, firstPublicationDate: '2026-10-20' }, ['bio.mol']);
  assert.equal(current!.year, 2026);
  assert.equal(current!.published, '2026-10-20');
});

test('maps CORE, OSTI and NASA records to stable open paper records', () => {
  const core = mapCoreWork({ id: 1, title: 'Mechanical result', authors: [{ name: 'A' }], downloadUrl: 'https://core.ac.uk/download/1.pdf', yearPublished: 2025 }, ['mech.mfg']);
  const osti = mapOstiRecord({ osti_id: '2', title: 'Battery result', description: 'Energy storage', publication_date: '2026-01-01', links: [{ rel: 'fulltext', href: 'https://www.osti.gov/servlets/purl/2' }] }, ['chemeng.energy']);
  const nasa = mapNasaRecord({ id: 3, title: 'Aerodynamic result', abstract: 'Flight', publications: [{ publicationDate: '2024-01-01' }], downloads: [{ links: { pdf: '/api/citations/3/downloads/paper.pdf' } }] }, ['mech.aero']);
  // None of the three records names a subject, so none has a category.
  assert.deepEqual([core, osti, nasa].map(paper => paper!.primaryCategory), ['', '', '']);
  assert.equal(core!.openAccess, true);
  assert.equal(osti!.openAccess, true);
  assert.equal(nasa!.pdfUrl, 'https://ntrs.nasa.gov/api/citations/3/downloads/paper.pdf');
});

// Two Europe PMC core searches saved by the 2026-10-20 classification audit
// (PAP-60), each beside the categories whose labels it searched. Trimmed to
// the fields the mapper reads, leaving out abstracts and authors.
const europePmcSearches = (JSON.parse(readFileSync(new URL('./europe-pmc-request-order.fixture.json', import.meta.url), 'utf8')) as {
  requests: Array<{ query: string; categories: string[]; results: Array<Parameters<typeof mapEuropePmcSearchResult>[0]> }>;
}).requests;

const orders = (categories: string[]): string[][] => (categories.length <= 1
  ? [categories]
  : categories.flatMap((category, index) => orders(categories.filter((_, other) => other !== index))
    .map(rest => [category, ...rest])));

const classification = (paper: Partial<Paper> | null) => ({
  primaryCategory: paper?.primaryCategory,
  categories: paper?.categories,
  allCategories: paper?.allCategories,
});

// The mapper filed a record under the first requested category its terms did
// not rule out, so 37 of these 50 changed field with nothing but the order of
// the request. PMID 42820985, a rice QTL study, was Genetics or Ecology.
test('a Europe PMC record is classified the same whichever order the requested categories came in', () => {
  assert.equal(europePmcSearches.flatMap(search => search.results).length, 50);
  const changed: string[] = [];
  for (const { categories, results } of europePmcSearches) {
    for (const raw of results) {
      const [first, ...others] = orders(categories).map(order => classification(mapEuropePmcSearchResult(raw, order)));
      if (others.some(other => !isDeepStrictEqual(other, first))) changed.push(raw.pmid || raw.id!);
    }
  }
  assert.deepEqual(changed, []);
});

test('a Europe PMC record carries the requested categories only as the reason it was fetched', () => {
  for (const { categories, results } of europePmcSearches) {
    for (const raw of results) {
      const paper = mapEuropePmcSearchResult(raw, categories)!;
      const classified = [paper.primaryCategory, ...paper.categories!, ...paper.allCategories!];
      assert.deepEqual(categories.filter(category => classified.includes(category)), [], `PMID ${raw.pmid}`);
      assert.deepEqual(new Set(paper._fetchedFor), new Set(categories), `PMID ${raw.pmid}`);
    }
  }
});

// Whichever of the requested categories the reader picked, the card ranks
// as theirs; the stamp gave that only to the first one.
test('a Europe PMC card ranks as a requested category without carrying it', () => {
  const { categories, results } = europePmcSearches[0];
  const rice = results.find(raw => raw.pmid === '42820985')!;
  const paper = mapEuropePmcSearchResult(rice, categories)!;
  const preference = (userPreferences: string[]) => scorePaperForRecommendation(paper, { userPreferences }).preference;
  assert.deepEqual(categories, ['bio.gen', 'bio.eco']);
  assert.equal(preference(['bio.gen']), 100);
  assert.equal(preference(['bio.eco']), 100);
  assert.equal(preference(['bio.neuro']), 0, 'a category the source was not asked for earns nothing');
});

// A Europe PMC record names no category of the taxonomy, so its card has no
// field until OpenAlex supplies one. Before the stored copies kept their
// evidence (PAP-60), the card read Biology from a guess over all its terms,
// while a savedPapers document kept only the first term ("Nitrogen" for
// PMID 42820985) and read nothing: saving changed the field of 27 of these 50.
test('saving or liking a Europe PMC card leaves its field as the feed showed it', () => {
  const throughFirestore = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const field = (paper: Partial<Paper>) => [areaKeyForPaper(paper), areaLabelForPaper(paper), areaAccentForPaper(paper)];
  const changed: string[] = [];
  for (const { categories, results } of europePmcSearches) {
    for (const raw of results) {
      const card = mapEuropePmcSearchResult(raw, categories)!;
      const copies: Array<[string, Partial<Paper>]> = [
        ['interaction copy', paperLegacyAdapter(throughFirestore(serializeLibraryPaper(card)))],
        ['savedPapers document', paperLegacyAdapter({ id: card.id, ...throughFirestore(buildSavedPaperPayload(card, '2026-10-20T12:00:00.000Z')) })],
        // An interaction saved without a copy, read as the feed reads it.
        ['fields-only record', paperLegacyAdapter(serializeLibraryPaper({ id: card.id, title: card.title, authors: card.authors, published: card.published }))],
      ];
      for (const [copy, stored] of copies) {
        if (!isDeepStrictEqual(field(stored), field(card))) changed.push(`PMID ${raw.pmid}, ${copy}`);
      }
    }
  }
  assert.deepEqual(changed, []);

  const { categories, results } = europePmcSearches[0];
  const rice = mapEuropePmcSearchResult(results.find(raw => raw.pmid === '42820985')!, categories)!;
  assert.equal(areaLabelForPaper(rice), null, 'nothing in the record names its field');
});

// Synthetic records shaped like each provider's payload. A category the
// provider states, read through the taxonomy, files the paper; nothing else
// does, and no request changes that.
test('the specialist mappers classify a record by what its provider says, whatever was requested', () => {
  const cases: Array<{ source: string; requested: string[]; expected: string | null; map: (requested: string[]) => Paper | null }> = [
    {
      source: 'bioRxiv',
      requested: ['bio.gen', 'bio.eco'],
      expected: 'bio.neuro',
      map: requested => mapBioRxivPaper({ doi: '10.1101/2026.01.01.000001', title: 'Cortical circuits in mice', category: 'neuroscience', date: '2026-01-01' }, requested),
    },
    {
      source: 'ADS',
      requested: ['hep-th', 'astro-ph.CO'],
      expected: 'astro-ph.GA',
      map: requested => mapAdsPaper({ bibcode: '2026ApJ...1A', title: ['A galaxy survey'], arxiv_class: ['astro-ph.GA'], keyword: ['galaxies: evolution'], year: 2026, abstract: 'Galaxies.', author: ['Researcher, Ada'] }, requested),
    },
    {
      source: 'INSPIRE',
      requested: ['hep-th', 'gr-qc', 'hep-ph'],
      expected: 'hep-ph',
      map: requested => mapInspirePaper({ metadata: { control_number: 1, titles: [{ title: 'Dark matter at colliders' }], primary_arxiv_category: ['hep-ph'], inspire_categories: [{ term: 'Phenomenology-HEP' }] } }, requested),
    },
    {
      source: 'Europe PMC',
      requested: ['bio.gen', 'bio.eco'],
      expected: null,
      map: requested => mapEuropePmcSearchResult({ pmid: '1', title: 'A record without terms' }, requested),
    },
    {
      source: 'CORE',
      requested: ['civil.struct', 'mech.fluid'],
      expected: null,
      map: requested => mapCoreWork({ id: 9, title: 'Concrete fatigue under cyclic loading' }, requested),
    },
    {
      source: 'OSTI',
      requested: ['chemeng.energy', 'eess.power'],
      expected: null,
      map: requested => mapOstiRecord({ osti_id: 1, title: 'Grid batteries', subjects: ['25 ENERGY STORAGE'] }, requested),
    },
    {
      source: 'NASA',
      requested: ['mech.aero', 'mech.fluid'],
      expected: null,
      map: requested => mapNasaRecord({ id: 1, title: 'Wing flutter', subjectCategories: ['Fluid Mechanics And Thermodynamics'] }, requested),
    },
  ];
  for (const { source, requested, expected, map } of cases) {
    const requests = [...orders(requested), [requested[0]], []];
    const [first, ...others] = requests.map(request => classification(map(request)));
    if (expected) {
      assert.equal(first.primaryCategory, expected, source);
    } else {
      const classified = [first.primaryCategory, ...first.categories!, ...first.allCategories!];
      assert.deepEqual(requested.filter(category => classified.includes(category)), [], source);
    }
    others.forEach((other, index) => assert.deepEqual(other, first, `${source} asked for ${requests[index + 1].join(', ') || 'nothing'}`));
  }
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
    keyword: ['11.25.Tq', 'Cosmology'],
    arxiv_class: ['astro-ph.CO'],
    citation_count: 17,
    reference: ['2020ApJ...111..222A'],
    property: ['REFEREED', 'EPRINT_OPENACCESS'],
    pub: 'The Astrophysical Journal',
    doctype: 'article',
  }, ['astro-ph.CO']);

  assert.equal(paper!.sources.primary, 'nasa-ads');
  assert.equal(paper!.primaryCategory, 'astro-ph.CO');
  assert.equal(paper!.arxivId, '2601.12345');
  assert.equal(paper!.doi, '10.1000/ads');
  assert.equal(paper!.citationCount, 17);
  assert.equal(paper!.referenceCount, 1);
  assert.equal(paper!.peerReviewed, true);
  assert.equal(paper!.openAccess, true);
  assert.match(paper!.adsUrl!, /ui\.adsabs\.harvard\.edu/);
  assert.deepEqual(paper!.categories, ['astro-ph.CO', 'Cosmology']);
  assert.ok(!paper!.concepts!.some(concept => concept.display_name === '11.25.Tq'));
  assert.ok(paper!.keywords!.includes('11.25.Tq'));
});

test('an ADS date with an unknown day or month keeps the month or year it names', () => {
  const published = (pubdate: string) => mapAdsPaper({ bibcode: '2018PhRvL.120a0001A', title: ['A dated ADS record'], abstract: 'A.', year: 2018, pubdate })!.published;
  assert.equal(published('2018-03-00'), '2018-03');
  assert.equal(published('2018-00-00'), '2018');
  assert.equal(published('2018-03-14'), '2018-03-14');
  assert.equal(new Date(published('2018-03-00')!).toISOString(), '2018-03-01T00:00:00.000Z', 'read as the first day of the month');
});

// Real record, 2026NatSR..16.2819Z as ADS served it on 2026-09-23: the title
// verbatim; the abstract cut to its formulas and scripts, and the `<P />` ADS
// writes between paragraphs.
const ADS_PREAMBLE = '\\documentclass[12pt]{minimal} \\usepackage{amsmath} \\usepackage{wasysym} '
  + '\\usepackage{amsfonts} \\usepackage{amssymb} \\usepackage{amsbsy} \\usepackage{mathrsfs} '
  + '\\usepackage{upgreek} \\setlength{\\oddsidemargin}{-69pt} \\begin{document}';

test('reads the markup of an ADS title and abstract instead of flattening it to spaces', () => {
  const paper = mapAdsPaper({
    bibcode: '2026NatSR..16.2819Z',
    title: [`Quantum avalanches in <tex-math id="IEq1_TeX">&lt;![CDATA[${ADS_PREAMBLE}{Z}_2]]&gt;</tex-math>`
      + '-preserving interacting Ising Majorana chain'],
    author: ['Zhang, Lv', 'Xu, Kai', 'Fan, Heng'],
    abstract: 'Here, we consider the transition temperature T<SUB>c</SUB><SUP>0</SUP>'
      + `<tex-math id="IEq2_TeX">&lt;![CDATA[${ADS_PREAMBLE}$\${T}_{{{{{c}}}}}<SUP>0</SUP>$$]]&gt;</tex-math>`
      + ' of La<SUB>2-x</SUB>Sr<SUB>x</SUB>CuO<SUB>4</SUB>. <P />Supported by NSF.',
    year: 2026,
    pubdate: '2026-12-00',
    doi: ['10.1038/s41598-025-32723-2'],
  }, ['quant-ph']);

  assert.equal(paper!.title, 'Quantum avalanches in \\({Z}_2\\)-preserving interacting Ising Majorana chain');
  assert.equal(
    paper!.abstract,
    'Here, we consider the transition temperature \\({T}_{{{{{c}}}}}^{0}\\) of La2-xSrxCuO4. Supported by NSF.',
  );
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

  assert.equal(paper!.sources.primary, 'inspire');
  assert.equal(paper!.primaryCategory, 'hep-ph');
  assert.equal(paper!.citationCount, 8);
  assert.equal(paper!.citationCountKnown, true);
  assert.equal(paper!.publicationStatus, 'published');
  assert.match(paper!.inspireUrl!, /inspirehep\.net\/literature\/12345/);
});

test('the same categories reach the protected sources once there is a session', () => {
  const plan = getDomainSourcePlan(['astro-ph.CO', 'mech.aero', 'bio.cell']);

  const guest = getEligibleDomainSources(plan, { hasSession: false, scopusEnabled: true });
  const member = getEligibleDomainSources(plan, { hasSession: true, scopusEnabled: true });

  assert.equal(guest.physics, false);
  assert.equal(guest.core, false);
  assert.equal(guest.scopus, false);
  assert.equal(member.physics, true);
  assert.equal(member.core, true);
  assert.equal(member.scopus, true);
  assert.equal(guest.europepmc, true, 'public sources are untouched by the gate');
  assert.equal(getEligibleDomainSources(plan, { hasSession: true }).scopus, false, 'Scopus still needs its own flag');
});

test('a rejected source names its path instead of vanishing', () => {
  const logged: string[] = [];
  const settled = [
    { status: 'fulfilled' as const, value: [] },
    { status: 'rejected' as const, reason: Object.assign(new Error('WORKER_AUTH_REQUIRED'), { code: 'WORKER_AUTH_REQUIRED' }) },
    { status: 'rejected' as const, reason: new Error('/sources/nasa returned 429') },
  ];
  const entries = [
    { path: '/sources/biorxiv' },
    { path: '/sources/physics' },
    { path: '/sources/nasa' },
  ];

  reportDomainSourceFailures(settled, entries, message => logged.push(message));

  assert.equal(logged.length, 2);
  assert.match(logged[0], /\/sources\/physics.*WORKER_AUTH_REQUIRED/);
  assert.match(logged[1], /\/sources\/nasa.*429/);
});

// The regression this file exists to hold: `Promise.allSettled` settles only
// when its slowest member does, and every caller wraps the whole domain branch
// in one render budget -- so a single upstream stalling past that budget threw
// away the papers its siblings had already delivered. Budgeting each source on
// its own is what keeps a stall local to the source that stalled.
test('a source that hangs past its budget does not discard the ones that answered', async () => {
  const logged: string[] = [];
  const requests = [
    { path: '/sources/biorxiv', promise: new Promise(() => {}) },
    { path: '/sources/europepmc', promise: Promise.resolve([{ id: 'europepmc-1' }]) },
    { path: '/sources/huggingface', promise: Promise.resolve([{ id: 'hf-1' }]) },
  ];

  const settled = await settleDomainSources(requests, 20, message => logged.push(message));

  assert.deepEqual(settled.map(result => result.status), ['timed_out', 'fulfilled', 'fulfilled']);
  assert.deepEqual((settled[1] as { status: 'fulfilled'; value: unknown }).value, [{ id: 'europepmc-1' }]);
  assert.deepEqual((settled[2] as { status: 'fulfilled'; value: unknown }).value, [{ id: 'hf-1' }]);
  assert.match(logged.join('\n'), /\/sources\/biorxiv/, 'a stalled source is named, not silent');
});

test('a rejected source still names its path once each source is budgeted alone', async () => {
  const logged: string[] = [];
  const requests = [
    { path: '/sources/openreview', promise: Promise.reject(new Error('/sources/openreview returned 502')) },
    { path: '/sources/europepmc', promise: Promise.resolve([{ id: 'europepmc-1' }]) },
  ];

  const settled = await settleDomainSources(requests, 20, message => logged.push(message));

  assert.deepEqual(settled.map(result => result.status), ['rejected', 'fulfilled']);
  assert.match(logged.join('\n'), /\/sources\/openreview failed: \/sources\/openreview returned 502/);
});

// `${path} returned ${status}` threw the Worker's body away, and with it the
// `code` and `upstreamStatus` that tell a 400 of our own making from an outage
// of theirs (and NCBI's 429 from the ledger's). The body travels on the error,
// where `reportDomainSourceFailures` already looks for `code`.
test('a refused source keeps the Worker body on the error instead of only the status', () => {
  const masked = sourceResponseError('/sources/openreview', 502, {
    error: 'Specialist source unavailable',
    upstreamStatus: 400,
  } as NonNullable<Parameters<typeof sourceResponseError>[2]> & Record<string, unknown>);
  assert.equal(masked.status, 502);
  assert.equal(masked.upstreamStatus, 400);
  assert.equal(masked.code, undefined);
  assert.equal(masked.message, '/sources/openreview returned 502 (upstream 400)');

  const refused = sourceResponseError('/sources/pubmed', 429, {
    error: 'Specialist source unavailable',
    code: 'UPSTREAM_RATE_LIMITED',
  } as NonNullable<Parameters<typeof sourceResponseError>[2]> & Record<string, unknown>);
  assert.equal(refused.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(refused.message, '/sources/pubmed returned 429 (UPSTREAM_RATE_LIMITED)');

  const bare = sourceResponseError('/sources/biorxiv', 502, null);
  assert.equal(bare.message, '/sources/biorxiv returned 502');
  assert.equal(bare.code, undefined);
  assert.equal(bare.upstreamStatus, undefined);

  const hostile = sourceResponseError('/sources/core', 502, { code: 42, upstreamStatus: '400' as never });
  assert.equal(hostile.code, undefined, 'a code that is not a string is not a code');
  assert.equal(hostile.upstreamStatus, undefined, 'a status that is not an integer is not a status');
});

test('the failure report shows the upstream status once the body travels on the error', () => {
  const logged: string[] = [];
  reportDomainSourceFailures(
    [{ status: 'rejected' as const, reason: sourceResponseError('/sources/openreview', 502, { upstreamStatus: 400 }) }],
    [{ path: '/sources/openreview' }],
    message => logged.push(message),
  );

  assert.equal(logged.length, 1);
  assert.match(logged[0], /\/sources\/openreview failed: \/sources\/openreview returned 502 \(upstream 400\)/);
});

