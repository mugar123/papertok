import type { Paper, PaperAuthor } from '../models/Paper.ts';
import type { OpenAlexWork } from './adapters/openAlexTypes.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBuilder } from './PaperBuilder.ts';
import { mapCrossrefInstitutionWork } from './crossrefInstitutionService.ts';
import { mapOpenAlexEnrichmentWork, slimWorksPage } from './openAlexService.ts';
import { OpenAlexAdapter } from './adapters/OpenAlexAdapter.ts';
import { SemanticScholarAdapter } from './adapters/SemanticScholarAdapter.ts';
import { scorePaperForRecommendation } from '../utils/recommendationEngine.ts';
import { reviewTagForPaper } from '../utils/paperStatus.ts';
import { filterAndSortEntityPapers } from '../utils/entityExplorer.ts';

test('normalizes category and publication metadata used by ranking', () => {
  const paper = PaperBuilder.create({
    id: 'arxiv:2607.00001',
    title: 'Optics paper',
    categories: ['physics.optics', 'quant-ph'],
    published: '2026-07-01T00:00:00Z',
    citationsCount: 12,
    authors: [{ name: 'Ada Researcher' }],
  });

  assert.equal(paper.primaryCategory, 'physics.optics');
  assert.deepEqual(paper.allCategories, ['physics.optics', 'quant-ph']);
  assert.equal(paper.published, '2026-07-01T00:00:00Z');
  assert.equal(paper.citationCount, 12);

  const score = scorePaperForRecommendation(paper, {
    now: new Date('2026-07-02T00:00:00Z').getTime(),
    userPreferences: ['physics.optics'],
    followedAuthors: ['Ada Researcher'],
  });
  assert.equal(score.preference, 100);
  assert.equal(score.authorBoost, 50);
});

test('OpenAlex enrichment remains available to the recommendation engine', () => {
  const paper = PaperBuilder.create({ id: 'arxiv:1', title: 'Paper', publicationType: 'preprint' });
  const enriched = PaperBuilder.merge(paper, {
    citationCount: 42,
    citationCountKnown: true,
    concepts: [{ id: 'concept-1', score: 0.5 }],
  }, 'openalex');

  const score = scorePaperForRecommendation(enriched, {
    conceptAffinities: { 'concept-1': 1 },
  });

  assert.equal(enriched.openAlex!.citationCount, 42);
  assert.equal(enriched.citationCountKnown, true);
  assert.ok(score.citations > 0);
  assert.ok(score.semantic > 0);
});

test('keeps a confirmed zero citation count distinct from missing metadata', () => {
  const paper = PaperBuilder.create({ id: 'arxiv:2', title: 'New paper' });
  const enriched = PaperBuilder.merge(paper, {
    citationCount: 0,
    citationCountKnown: true,
  }, 'openalex');

  assert.equal(enriched.citationCount, 0);
  assert.equal(enriched.citationCountKnown, true);
});

test('does not treat an OpenAlex repository as a verified publication', () => {
  const paper = PaperBuilder.create({
    id: 'arxiv:2607.08264',
    title: 'New arXiv paper',
    publicationType: 'preprint',
    publicationStatus: 'preprint' as const,
  });
  const enriched = PaperBuilder.merge(paper, {
    publicationType: 'repository',
    publicationStatus: 'preprint' as const,
  }, 'openalex');

  assert.equal(enriched.publicationType, 'preprint');
  assert.equal(enriched.publicationStatus, 'preprint');
  assert.equal(enriched.peerReviewed, false);
});

test('does not mark a repository-hosted preprint as peer reviewed', () => {
  const paper = PaperBuilder.create({
    id: 'openalex:W7168054384',
    title: 'Repository preprint',
    publicationType: 'repository',
    publicationStatus: 'preprint' as const,
  });

  assert.equal(paper.peerReviewed, false);
});

test('merging an abstract does not manufacture peer review', () => {
  // The recalculation at the end of `merge` was unconditional, so a record that
  // says outright it was not reviewed had that denial overwritten by an
  // enrichment that only carried text: `published` + a type that is not
  // `preprint` came out `peerReviewed: true`.
  const base = PaperBuilder.create({
    id: 'ads:1',
    title: 'Report',
    publicationType: 'techreport',
    publicationStatus: 'published' as const,
    peerReviewed: false,
  });
  const merged = PaperBuilder.merge(base, { abstract: 'Now with text.' }, 'ads');

  assert.equal(merged.peerReviewed, false);
});

test('a working paper stays unreviewed when another provider also lists it as published', () => {
  // OpenAlex says what it is (`openAlexPeerReviewed`); a Semantic Scholar row
  // for the same DOI only says `published`, which used to re-derive `true`.
  const openAlex = {
    id: 'openalex:W7215107402',
    doi: '10.5089/9798229063456.001',
    title: 'An IMF working paper',
    publicationType: 'article',
    publicationStatus: 'published' as const,
    peerReviewed: false,
    sources: { primary: 'openalex', enrichedBy: [] },
  };
  const semanticScholar = {
    id: 's2:abc',
    doi: '10.5089/9798229063456.001',
    title: 'An IMF working paper',
    publicationType: 'JournalArticle',
    publicationStatus: 'published' as const,
    sources: { primary: 'semantic_scholar', enrichedBy: [] },
  };

  for (const order of [[openAlex, semanticScholar], [semanticScholar, openAlex]]) {
    const [paper] = PaperBuilder.deduplicate(order);
    assert.equal(paper.peerReviewed, false);
  }
});

test('the working-paper tag stays through a merge while the paper stays unreviewed', () => {
  const doi = '10.5089/9798229063456.001';
  const imf = {
    id: 'openalex:W7215107402',
    doi,
    title: 'An IMF working paper',
    publicationType: 'article',
    publicationStatus: 'published' as const,
    peerReviewed: false,
    workingPaper: true,
    sources: { primary: 'openalex', enrichedBy: [] },
  };
  // Records for the same DOI that say published, reviewed or not, and nothing
  // about a working paper.
  const semanticScholar = { ...imf, id: 's2:abc', publicationType: 'JournalArticle', peerReviewed: undefined, workingPaper: undefined, sources: { primary: 'semantic_scholar', enrichedBy: [] } };
  const crossref = { ...imf, id: 'crossref:1', publicationType: 'publication', workingPaper: undefined, sources: { primary: 'crossref', enrichedBy: [] } };

  for (const order of [[imf, semanticScholar], [semanticScholar, imf], [imf, crossref], [crossref, imf]]) {
    const [paper] = PaperBuilder.deduplicate(order);
    assert.equal(reviewTagForPaper(paper)?.label, 'Working paper', order.map(record => record.id).join(' then '));
  }

  // A venue's answer clears it: OpenAlex's journal article stays reviewed and untagged.
  const article = { ...imf, id: 'openalex:W100', peerReviewed: true, workingPaper: undefined };
  const merged = PaperBuilder.merge(PaperBuilder.create(article), imf, 'openalex');
  assert.equal(merged.peerReviewed, true);
  assert.equal(reviewTagForPaper(merged), null);
});

test('a journal article joined to its working paper by title alone is not tagged as one', () => {
  // A journal article and its working paper usually share title and first
  // author but not a DOI. Synthetic records, shaped as the mappers return them.
  const title = 'Monetary policy and bank lending in small open economies';
  const authors = [{ name: 'Ana Economist' }];
  const openAlex = { title, authors, publicationStatus: 'published' as const, sources: { primary: 'openalex', enrichedBy: [] } };
  const arxiv = PaperBuilder.create({
    id: '2601.00001',
    arxivId: '2601.00001',
    title,
    authors,
    publicationType: 'preprint',
    publicationStatus: 'preprint',
    sources: { primary: 'arxiv', enrichedBy: [] },
  });
  const article = { ...openAlex, id: 'openalex:W100', doi: '10.1000/ijcb.1', publicationType: 'article', peerReviewed: true };
  const imf = { ...openAlex, id: 'openalex:W200', doi: '10.5089/imf.1', publicationType: 'article', peerReviewed: false, workingPaper: true };

  const rows = PaperBuilder.deduplicate([arxiv, article, imf]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doi, '10.1000/ijcb.1');
  assert.equal(reviewTagForPaper(rows[0]), null);

  const nber = { ...openAlex, id: 'openalex:W300', doi: '10.3386/w1', publicationType: 'report', peerReviewed: false, workingPaper: true };
  for (const primary of ['pubmed', 'crossref']) {
    const journalArticle = {
      id: `${primary}:1`,
      doi: '10.1000/jhe.1',
      title,
      authors,
      journal: 'Journal of Health Economics',
      publicationType: 'journal-article',
      publicationStatus: 'published' as const,
      sources: { primary, enrichedBy: [] },
    };
    const joined = PaperBuilder.deduplicate([journalArticle, nber]);
    assert.equal(joined.length, 1, primary);
    assert.equal(joined[0].doi, '10.1000/jhe.1');
    assert.equal(reviewTagForPaper(joined[0]), null, primary);
  }
});

test('a working paper joined to a different article by title alone does not unreview the article', () => {
  // Synthetic records: an IMF working paper shaped as OpenAlex search returns
  // it, and its journal version shaped as PubMed returns it and mapped by the
  // Crossref institution fallback. Same title and first author, different
  // DOIs, so `deduplicate` joins them on the title.
  const title = 'Monetary policy and bank lending in small open economies';
  const imfDoi = '10.5089/9798229063456.001';
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const workingPaper = {
    id: 'openalex:W200',
    sources: { primary: 'openalex', enrichedBy: [] },
    doi: imfDoi,
    title,
    authors: [{ name: 'Ana Economist', id: 'https://openalex.org/A1' }],
    publicationType: 'article',
    publicationStatus: 'published' as const,
    peerReviewed: false,
    workingPaper: true,
    provider: 'openalex',
  };
  const pubmedArticle = (doi: string) => ({
    id: 'pmid:41000001',
    pmid: '41000001',
    sources: { primary: 'pubmed', enrichedBy: [] },
    doi,
    title,
    authors: [{ name: 'Economist A' }],
    journal: 'J Int Econ',
    publicationStatus: 'published' as const,
    publicationType: 'article',
    provider: 'pubmed',
  });
  const crossrefArticle = (doi: string) => mapCrossrefInstitutionWork({
    DOI: doi,
    title: [title],
    type: 'journal-article',
    author: [{ given: 'Ana', family: 'Economist' }],
    'container-title': ['Journal of International Economics'],
    publisher: 'Elsevier BV',
  })!;
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  for (const [provider, article] of [['pubmed', pubmedArticle], ['crossref', crossrefArticle]] as const) {
    // The article first: the row keeps its DOI and journal, and its review.
    const rows = PaperBuilder.deduplicate([article(journalDoi), workingPaper]);
    assert.equal(rows.length, 1, provider);
    assert.equal(rows[0].doi, journalDoi, provider);
    assert.equal(rows[0].peerReviewed, true, provider);
    assert.equal(reviewTagForPaper(rows[0]), null, provider);
    assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], provider);

    // The working paper first: the row is the working paper, with its own DOI
    // and its own answer. The article's review does not cross over either,
    // nor its journal and publisher.
    const [paper] = PaperBuilder.deduplicate([workingPaper, article(journalDoi)]);
    assert.equal(paper.doi, imfDoi, provider);
    assert.equal(paper.journal, undefined, provider);
    assert.equal(paper.publisher, undefined, provider);
    assert.equal(paper.peerReviewed, false, provider);
    assert.equal(reviewTagForPaper(paper)?.label, 'Working paper', provider);

    // A shared DOI is one record, so the working paper's answer and tag still
    // win in either order.
    for (const order of [[article(imfDoi), workingPaper], [workingPaper, article(imfDoi)]]) {
      const [twin] = PaperBuilder.deduplicate(order);
      assert.equal(twin.peerReviewed, false, `${provider}, shared DOI`);
      assert.equal(reviewTagForPaper(twin)?.label, 'Working paper', `${provider}, shared DOI`);
      assert.deepEqual(peerReviewedOnly([twin]), [], `${provider}, shared DOI`);
    }
  }

  // Nor does a different record's `false` fill a gap: an OpenAlex work with
  // no venue stays unknown.
  const noVenue = { ...workingPaper, id: 'openalex:W300', doi: '10.1000/no-venue', peerReviewed: undefined, workingPaper: undefined };
  const [gap] = PaperBuilder.deduplicate([noVenue, workingPaper]);
  assert.equal(gap.doi, '10.1000/no-venue');
  assert.equal(gap.peerReviewed, undefined);
  assert.equal(reviewTagForPaper(gap), null);

  // A shared arXiv id does not make two publishers' DOIs one record. The
  // working paper lists the eprint among its locations, and so do the journal
  // version's records: arXiv's own, which lists the journal's DOI and
  // reference (the feed puts it before the working paper), and Semantic
  // Scholar's. `deduplicate` joins each pair on the arXiv id.
  const eprintWorkingPaper = { ...workingPaper, arxivId: '2601.00001' };
  const journalVersions = {
    arxiv: PaperBuilder.create({
      id: '2601.00001',
      arxivId: '2601.00001',
      sources: { primary: 'arxiv', enrichedBy: [] },
      title,
      authors: [{ name: 'Ana Economist' }],
      doi: journalDoi,
      journal: 'J. Int. Econ. 160 (2026) 103900',
      publicationType: 'article',
      publicationStatus: 'published',
    }),
    semanticScholar: {
      id: 's2:abc',
      doi: journalDoi,
      arxivId: '2601.00001v2',
      title,
      authors: [{ name: 'Ana Economist' }],
      publicationType: 'JournalArticle',
      publicationStatus: 'published' as const,
      sources: { primary: 'semantic_scholar', enrichedBy: [] },
    },
  };
  for (const [provider, journalVersion] of Object.entries(journalVersions)) {
    const [article] = PaperBuilder.deduplicate([journalVersion, eprintWorkingPaper]);
    assert.equal(article.doi, journalDoi, provider);
    assert.equal(article.peerReviewed, true, provider);
    assert.equal(reviewTagForPaper(article), null, provider);
    assert.deepEqual(peerReviewedOnly([article]).map(row => row.doi), [journalDoi], provider);

    const [paper] = PaperBuilder.deduplicate([eprintWorkingPaper, journalVersion]);
    assert.equal(paper.doi, imfDoi, provider);
    assert.equal(paper.peerReviewed, false, provider);
    assert.equal(reviewTagForPaper(paper)?.label, 'Working paper', provider);

    // Nor does a working paper with no DOI at all: the shared eprint is the
    // only link, and the row keeps the journal's DOI.
    const [stillArticle] = PaperBuilder.deduplicate([journalVersion, { ...eprintWorkingPaper, doi: undefined }]);
    assert.equal(stillArticle.doi, journalDoi, provider);
    assert.equal(stillArticle.peerReviewed, true, provider);
    assert.equal(reviewTagForPaper(stillArticle), null, provider);
    assert.deepEqual(peerReviewedOnly([stillArticle]).map(row => row.doi), [journalDoi], provider);

    // The same pair the other way round is the working paper, and it does not
    // take the journal's DOI: that DOI shows one answer in either order. Nor
    // the journal's name, which arXiv's record carries in its reference.
    const [stillWorkingPaper] = PaperBuilder.deduplicate([{ ...eprintWorkingPaper, doi: undefined }, journalVersion]);
    assert.equal(stillWorkingPaper.doi, undefined, provider);
    assert.equal(stillWorkingPaper.journal, undefined, provider);
    assert.equal(stillWorkingPaper.peerReviewed, false, provider);
    assert.equal(reviewTagForPaper(stillWorkingPaper)?.label, 'Working paper', provider);
  }

  // The working paper's own versions stay unreviewed and tagged in either
  // order: the eprint with no journal DOI, and OpenAlex's record of it under
  // arXiv's own DOI, which the mapper reads the arXiv id out of. Either one
  // first is a base with no publisher's DOI, so the shared arXiv id joins the
  // working paper's answer to it; the working paper first keeps its own.
  const eprint = PaperBuilder.create({
    id: '2601.00001',
    arxivId: '2601.00001v2',
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    publicationType: 'preprint',
    publicationStatus: 'preprint',
  });
  const openAlexPreprint = {
    id: 'openalex:W400',
    doi: '10.48550/arxiv.2601.00001',
    arxivId: '2601.00001',
    sources: { primary: 'openalex', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    publicationType: 'preprint',
    publicationStatus: 'preprint' as const,
    peerReviewed: false,
    provider: 'openalex',
  };
  for (const [label, preprint] of [['eprint', eprint], ['OpenAlex preprint', openAlexPreprint]] as const) {
    for (const order of [[preprint, eprintWorkingPaper], [eprintWorkingPaper, preprint]]) {
      const [twin] = PaperBuilder.deduplicate(order);
      assert.equal(twin.peerReviewed, false, label);
      assert.equal(reviewTagForPaper(twin)?.label, 'Working paper', label);
    }
  }
});

test('an unreviewed row that is not a working paper still takes the DOI it was missing', () => {
  // Semantic Scholar sends no publication type, which `create` reads as
  // unreviewed, and NASA ADS marks a proceedings paper NOT REFEREED. Neither
  // is a working paper, so the DOI OpenAlex lists for the same work fills the
  // gap. The Semantic Scholar record goes through its adapter; the others are
  // shaped as their mappers return them.
  const title = 'Dust attenuation curves in star forming galaxies at cosmic noon';
  const doi = '10.1117/12.3000001';
  const openAlex = {
    id: 'openalex:W9',
    sources: { primary: 'openalex', enrichedBy: [] },
    doi,
    arxivId: '2602.00002',
    title,
    authors: [{ name: 'Bea Astronomer', id: 'https://openalex.org/A9' }],
    publicationType: 'article',
    publicationStatus: 'published' as const,
    peerReviewed: true,
    provider: 'openalex',
  };
  const semanticScholar = new SemanticScholarAdapter().mapToStandard({
    paperId: 'f'.repeat(40),
    title,
    authors: [{ name: 'Bea Astronomer', authorId: '1' }],
    venue: 'SPIE',
    externalIds: {},
  });
  const ads = {
    id: 'ads:2026SPIE00001A',
    sources: { primary: 'nasa-ads', enrichedBy: [] },
    adsBibcode: '2026SPIE00001A',
    arxivId: '2602.00002',
    title,
    authors: [{ name: 'Astronomer, Bea' }],
    journal: 'Proceedings of the SPIE',
    publicationType: 'inproceedings',
    publicationStatus: 'published' as const,
    peerReviewed: false,
    provider: 'nasa-ads',
  };

  for (const [label, record] of [['Semantic Scholar', semanticScholar], ['NASA ADS', ads]] as const) {
    const [row] = PaperBuilder.deduplicate([record, openAlex]);
    assert.equal(row.doi, doi, label);
  }
});

test('a FEDS revision that arXiv lists under its own DOI stays a working paper beside the original', () => {
  // Synthetic records. The Federal Reserve Board issues a revised FEDS paper
  // under the original DOI plus `r1`, and arXiv records carry whichever DOI
  // the authors entered, with no journal reference. OpenAlex files the
  // original in the listed FEDS source with the eprint among its locations,
  // so `deduplicate` joins the two on the arXiv id. The working paper reaches
  // the feed and search through the OpenAlex adapter, the Explorer through
  // its works page, and an arXiv card through the enrichment.
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivId = '2601.00007';
  const fedsDoi = '10.17016/FEDS.2026.007';
  const fedsLocation = {
    landing_page_url: `https://doi.org/${fedsDoi}`,
    is_published: true,
    source: {
      id: 'https://openalex.org/S4210212089',
      display_name: 'Finance and Economics Discussion Series',
      type: 'journal',
      host_organization_name: 'Board of Governors of the Federal Reserve System',
    },
  };
  const fedsWork: OpenAlexWork = {
    id: 'https://openalex.org/W500',
    doi: `https://doi.org/${fedsDoi}`,
    title,
    type: 'article',
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
    publication_year: 2026,
    primary_location: fedsLocation,
    locations: [fedsLocation, {
      landing_page_url: `https://arxiv.org/abs/${arxivId}`,
      is_published: false,
      source: { display_name: 'arXiv (Cornell University)', type: 'repository' },
    }],
  };
  // As `arxivService` maps an entry: a DOI or a journal reference makes it a
  // published article.
  const arxivRecord = (doi: string, journal = '') => PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi,
    journal,
    publicationType: 'article',
    publicationStatus: 'published',
  });
  const searchRecord = () => new OpenAlexAdapter().mapToStandard(fedsWork)!;
  const explorerRecord = () => slimWorksPage({ results: [fedsWork] }).papers[0];
  const flows = (arxiv: Paper, { workingPaperFirst = true } = {}): Array<[string, Paper[]]> => [
    ['search, arXiv first', PaperBuilder.deduplicate([arxiv, searchRecord()])],
    ['Explorer page, arXiv first', PaperBuilder.deduplicate([arxiv, explorerRecord()])],
    ['Explorer across pages, arXiv first', PaperBuilder.deduplicate([...PaperBuilder.deduplicate([arxiv]), explorerRecord()])],
    ['feed enrichment', [PaperBuilder.merge(arxiv, mapOpenAlexEnrichmentWork(fedsWork)!.enrichment, 'openalex')]],
    ...(workingPaperFirst ? [
      ['search, working paper first', PaperBuilder.deduplicate([searchRecord(), arxiv])],
      ['Explorer page, working paper first', PaperBuilder.deduplicate([explorerRecord(), arxiv])],
      ['Explorer across pages, working paper first', PaperBuilder.deduplicate([...PaperBuilder.deduplicate([explorerRecord()]), arxiv])],
    ] as Array<[string, Paper[]]> : []),
  ];
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  // The revision's DOI comes from the registrant that issued the working
  // paper's, so the row is that working paper in every flow and order.
  for (const [flow, rows] of flows(arxivRecord(`${fedsDoi}r1`))) {
    assert.equal(rows.length, 1, flow);
    assert.equal(rows[0].peerReviewed, false, flow);
    assert.equal(reviewTagForPaper(rows[0])?.label, 'Working paper', flow);
    assert.deepEqual(peerReviewedOnly(rows), [], flow);
  }

  // The same eprint published in a journal, which arXiv records with the
  // journal's DOI and reference, stays reviewed when it arrives first.
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  for (const [flow, rows] of flows(arxivRecord(journalDoi, 'J. Int. Econ. 160 (2026) 103900'), { workingPaperFirst: false })) {
    assert.equal(rows.length, 1, flow);
    assert.equal(rows[0].doi, journalDoi, flow);
    assert.equal(rows[0].peerReviewed, true, flow);
    assert.equal(reviewTagForPaper(rows[0]), null, flow);
    assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], flow);
  }

  // A shared registrant joins only a working paper's versions. A Springer
  // chapter, which the Crossref fallback maps as unreviewed, does not unreview
  // the Springer journal article that shares its title and first author.
  const springer = (DOI: string, type: string, container: string) => mapCrossrefInstitutionWork({
    DOI,
    title: [title],
    type,
    author: [{ given: 'Ana', family: 'Economist' }],
    'container-title': [container],
    publisher: 'Springer',
  })!;
  const [springerArticle] = PaperBuilder.deduplicate([
    springer('10.1007/s11222-026-00001-1', 'journal-article', 'Statistics and Computing'),
    springer('10.1007/978-3-031-00001-1_1', 'book-chapter', 'Lecture Notes in Statistics'),
  ]);
  assert.equal(springerArticle.doi, '10.1007/s11222-026-00001-1');
  assert.equal(springerArticle.peerReviewed, true);
});

test('an arXiv record beside a working paper it is not takes neither its series nor its answer', () => {
  // Synthetic records through the real mappers. OpenAlex files the eprint
  // among a working paper's locations, so `deduplicate` joins it with the
  // arXiv record on the arXiv id; an arXiv card's enrichment can resolve to
  // that work too. The arXiv record comes first, as in the feed.
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivId = '2601.00007';
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const workingPaperWork = (doi: string | null, source: { id: string; display_name: string; type: string; host_organization_name?: string }, type: string): OpenAlexWork => {
    const location = {
      landing_page_url: doi ? `https://doi.org/${doi}` : 'https://www.nber.org/papers/w30000',
      is_published: true,
      source: { ...source, id: `https://openalex.org/${source.id}` },
    };
    return {
      id: 'https://openalex.org/W600',
      doi: doi ? `https://doi.org/${doi}` : null,
      title,
      type,
      authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
      publication_year: 2026,
      primary_location: location,
      locations: [location, {
        landing_page_url: `https://arxiv.org/abs/${arxivId}`,
        is_published: false,
        source: { display_name: 'arXiv (Cornell University)', type: 'repository' },
      }],
    };
  };
  const feds = workingPaperWork('10.17016/FEDS.2026.007', {
    id: 'S4210212089',
    display_name: 'Finance and Economics Discussion Series',
    type: 'journal',
    host_organization_name: 'Board of Governors of the Federal Reserve System',
  }, 'article');
  // As `arxivService` maps an entry: a DOI or a journal reference makes it a
  // published article.
  const arxivRecord = (doi: string, journal = '') => PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi,
    journal,
    publicationType: 'article',
    publicationStatus: 'published',
  });
  const flows = (arxiv: Paper, work: OpenAlexWork): Array<[string, Paper[]]> => [
    ['search', PaperBuilder.deduplicate([arxiv, new OpenAlexAdapter().mapToStandard(work)!])],
    ['Explorer page', PaperBuilder.deduplicate([arxiv, slimWorksPage({ results: [work] }).papers[0]])],
    ['Explorer across pages', PaperBuilder.deduplicate([...PaperBuilder.deduplicate([arxiv]), slimWorksPage({ results: [work] }).papers[0]])],
    ['feed enrichment', [PaperBuilder.merge(arxiv, mapOpenAlexEnrichmentWork(work)!.enrichment, 'openalex')]],
  ];

  // The journal version, which arXiv lists with the journal's DOI and its
  // reference, keeps its own journal and takes no publisher from the series.
  const reference = 'J. Int. Econ. 160 (2026) 103900';
  for (const [flow, rows] of flows(arxivRecord(journalDoi, reference), feds)) {
    assert.equal(rows.length, 1, flow);
    assert.equal(rows[0].doi, journalDoi, flow);
    assert.equal(rows[0].journal, reference, flow);
    assert.equal(rows[0].publisher, undefined, flow);
    assert.equal(rows[0].peerReviewed, true, flow);
    assert.equal(reviewTagForPaper(rows[0]), null, flow);
  }

  // Without the reference the row still shows the journal's DOI, and the
  // series is no more its journal than the Board is its publisher.
  for (const [flow, rows] of flows(arxivRecord(journalDoi), feds)) {
    assert.equal(rows.length, 1, flow);
    assert.equal(rows[0].doi, journalDoi, flow);
    assert.equal(rows[0].journal, undefined, flow);
    assert.equal(rows[0].publisher, undefined, flow);
    assert.equal(reviewTagForPaper(rows[0]), null, flow);
  }
});

test('a report from a journal\'s registrant does not unreview the journal article', () => {
  // Synthetic records. OpenAlex types an unlisted series' paper `report`, and
  // the St. Louis Fed registers both its working papers and its Review under
  // 10.20955. The journal article arrives as the Crossref institution fallback
  // maps it, or as arXiv lists it with the journal's DOI and reference.
  const title = 'Unemployment insurance and the dynamics of job search';
  const arxivId = '2601.00099';
  const journalDoi = '10.20955/r.102.12';
  const reportDoi = '10.20955/wp.2019.001';
  const reportLocation = {
    landing_page_url: `https://doi.org/${reportDoi}`,
    is_published: true,
    source: {
      id: 'https://openalex.org/S0000000001',
      display_name: 'Working Paper Series',
      type: 'repository',
      host_organization_name: 'Federal Reserve Bank of St. Louis',
    },
  };
  const reportWork: OpenAlexWork = {
    id: 'https://openalex.org/W900',
    doi: `https://doi.org/${reportDoi}`,
    title,
    type: 'report',
    authorships: [{ author: { id: 'https://openalex.org/A9', display_name: 'Ana Economist' } }],
    publication_year: 2019,
    primary_location: reportLocation,
    locations: [reportLocation, {
      landing_page_url: `https://arxiv.org/abs/${arxivId}`,
      is_published: false,
      source: { display_name: 'arXiv (Cornell University)', type: 'repository' },
    }],
  };
  const crossrefArticle = mapCrossrefInstitutionWork({
    DOI: journalDoi,
    title: [title],
    type: 'journal-article',
    author: [{ given: 'Ana', family: 'Economist' }],
    'container-title': ['Review'],
    publisher: 'Federal Reserve Bank of St. Louis',
  })!;
  const arxiv = PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi: journalDoi,
    journal: 'Fed. Reserve Bank St. Louis Rev. 102 (2020)',
    publicationType: 'article',
    publicationStatus: 'published',
  });
  // The eprint alone, which takes the journal's DOI from OpenAlex's record of
  // the article before the report merges in. The search mapper sets no
  // journal on either.
  const eprint = PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    publicationType: 'preprint',
    publicationStatus: 'preprint',
  });
  const reviewLocation = {
    landing_page_url: `https://doi.org/${journalDoi}`,
    is_published: true,
    source: { id: 'https://openalex.org/S43156200', display_name: 'Review', type: 'journal' },
  };
  const articleWork: OpenAlexWork = {
    ...reportWork,
    id: 'https://openalex.org/W901',
    doi: `https://doi.org/${journalDoi}`,
    type: 'article',
    publication_year: 2020,
    primary_location: reviewLocation,
    locations: [reviewLocation, reportWork.locations![1]],
  };
  const searchReport = () => new OpenAlexAdapter().mapToStandard(reportWork)!;
  const explorerReport = () => slimWorksPage({ results: [reportWork] }).papers[0];
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  for (const [flow, rows] of [
    ['eprint, OpenAlex article, report', PaperBuilder.deduplicate([eprint, new OpenAlexAdapter().mapToStandard(articleWork)!, searchReport()])],
    ['Crossref, search', PaperBuilder.deduplicate([crossrefArticle, searchReport()])],
    ['Crossref, Explorer page', PaperBuilder.deduplicate([crossrefArticle, explorerReport()])],
    ['arXiv, search', PaperBuilder.deduplicate([arxiv, searchReport()])],
    ['arXiv, Explorer page', PaperBuilder.deduplicate([arxiv, explorerReport()])],
    ['arXiv, Explorer across pages', PaperBuilder.deduplicate([...PaperBuilder.deduplicate([arxiv]), explorerReport()])],
    ['arXiv, feed enrichment', [PaperBuilder.merge(arxiv, mapOpenAlexEnrichmentWork(reportWork)!.enrichment, 'openalex')]],
  ] as Array<[string, Paper[]]>) {
    assert.equal(rows.length, 1, flow);
    assert.equal(rows[0].doi, journalDoi, flow);
    assert.equal(rows[0].peerReviewed, true, flow);
    assert.equal(reviewTagForPaper(rows[0]), null, flow);
    assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], flow);
  }
});

test('an OpenAlex record with no review evidence stays unknown through create and merge', () => {
  const unknown = {
    id: 'openalex:W3',
    doi: '10.1000/no-venue',
    title: 'No venue',
    publicationType: 'article',
    publicationStatus: 'published' as const,
    sources: { primary: 'openalex', enrichedBy: [] },
  };
  const arxivTwin = {
    id: 'arxiv:2601.00002',
    doi: '10.1000/no-venue',
    title: 'No venue',
    publicationType: 'preprint',
    publicationStatus: 'preprint' as const,
    peerReviewed: false,
    sources: { primary: 'arxiv', enrichedBy: [] },
  };

  assert.equal(PaperBuilder.create(unknown).peerReviewed, undefined);
  assert.equal(PaperBuilder.merge(PaperBuilder.create(unknown), { abstract: 'Now with text.' }, 'arxiv').peerReviewed, undefined);
  for (const order of [[unknown, arxivTwin], [arxivTwin, unknown]]) {
    const [paper] = PaperBuilder.deduplicate(order);
    assert.equal(paper.publicationStatus, 'published');
    assert.equal(paper.peerReviewed, undefined);
  }
});

test('a merged twin contributes the arXiv id the base was missing', () => {
  const merged = PaperBuilder.merge(
    { id: 'openalex:W1', title: 'A paper', sources: { primary: 'openalex', enrichedBy: [] } },
    { arxivId: '2401.12345', citationCount: 30 },
    'arxiv',
  );

  assert.equal(merged.arxivId, '2401.12345');
});

test('a base that knows its own arXiv id keeps it through a merge', () => {
  const merged = PaperBuilder.merge(
    {
      id: 'arxiv:2401.00001',
      arxivId: '2401.00001',
      title: 'A preprint',
      sources: { primary: 'arxiv', enrichedBy: [] },
    },
    { arxivId: '9999.99999' },
    'openalex',
  );

  assert.equal(merged.arxivId, '2401.00001');
});

test('deduplicates the same title and author when only one source has a DOI', () => {
  const deduplicated = PaperBuilder.deduplicate([
    {
      id: 'doi-source',
      doi: '10.1000/example',
      title: 'A Shared Research Result',
      authors: [{ name: 'Ada Researcher' }],
      provider: 'openalex',
    },
    {
      id: 'metadata-source',
      title: 'A Shared Research Result',
      authors: [{ name: 'Ada Researcher' }],
      summary: 'Abstract supplied by another source.',
      provider: 'pubmed',
    },
  ]);

  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0].doi, '10.1000/example');
});

test('deduplicates provider records by a stable arXiv identifier before title matching', () => {
  const deduplicated = PaperBuilder.deduplicate([
    {
      id: 'arxiv:2607.12345v2',
      arxivId: '2607.12345v2',
      title: 'Original title',
      authors: [{ name: 'Ada Researcher' }],
      provider: 'arxiv',
    },
    {
      id: 'hf-paper',
      huggingFaceId: '2607.12345',
      arxivId: '2607.12345',
      title: 'Revised title from the Hub',
      authors: [{ name: 'Ada Researcher' }],
      huggingFaceUpvotes: 12,
      provider: 'huggingface',
    },
  ]);

  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0].huggingFaceUpvotes, 12);
  assert.ok(deduplicated[0].sources.enrichedBy.includes('huggingface'));
});

test('deduplication keeps the citation count whichever source comes first', () => {
  // Adapters speak `citationsCount`; only `create` translates it. A raw duplicate
  // reaching `merge` as the enrichment carried its count in the name `merge`
  // never read, so arXiv-then-OpenAlex ended on a confirmed zero while
  // OpenAlex-then-arXiv kept the 250.
  const arx = PaperBuilder.create({
    id: 'arxiv:2401.00001',
    title: 'Same',
    authors: [{ name: 'A' }],
    sources: { primary: 'arxiv', enrichedBy: [] },
  });
  const oa = {
    id: 'W1',
    title: 'Same',
    authors: [{ name: 'A' }],
    arxivId: '2401.00001',
    citationsCount: 250,
    provider: 'openalex',
    sources: { primary: 'openalex', enrichedBy: [] },
  };

  const [merged] = PaperBuilder.deduplicate([arx, oa]);
  assert.equal(merged.citationCount, 250);
  assert.equal(merged.citationCountKnown, true);
});

/**
 * The bridge case. A and B share no key at all — different identifiers,
 * different titles — so they open two groups. C carries BOTH identifiers and is
 * the only record that can join them, and `deduplicate` took the first matching
 * key alone: C folded into B, then repointed A's arXiv key at the result, and A
 * fell out of the map entirely.
 */
const BRIDGE_A = {
  id: 'arxiv:2401.00002',
  arxivId: '2401.00002',
  title: 'Original title',
  authors: [{ name: 'A' }],
  sources: { primary: 'arxiv', enrichedBy: [] },
};
const BRIDGE_B = {
  id: '10.1000/bridge',
  doi: '10.1000/bridge',
  title: 'Revised title',
  authors: [{ name: 'A' }],
  sources: { primary: 'crossref', enrichedBy: [] },
};
const BRIDGE_C = {
  id: 'W9',
  doi: '10.1000/bridge',
  arxivId: '2401.00002',
  title: 'Revised title',
  authors: [{ name: 'A' }],
  sources: { primary: 'openalex', enrichedBy: [] },
};

test('a record carrying both identifiers folds the two groups into one', () => {
  const out = PaperBuilder.deduplicate([PaperBuilder.create(BRIDGE_A), BRIDGE_B, BRIDGE_C]);

  assert.equal(out.length, 1);
  assert.equal(out[0].doi, '10.1000/bridge');
  assert.equal(out[0].arxivId, '2401.00002');
});

test('a record with only a stable key is merged, never dropped', () => {
  // No authors, so no heuristic key: the arXiv id is the record's only thread
  // back into the map, and it was the one the bridge overwrote.
  const out = PaperBuilder.deduplicate([
    PaperBuilder.create({ ...BRIDGE_A, authors: [] }),
    BRIDGE_B,
    BRIDGE_C,
  ]);

  assert.equal(out.length, 1);
  assert.ok(out[0].sources.enrichedBy.includes('arxiv'), 'the arXiv record was folded in, not discarded');
});

test('fills a missing abstract from the OpenAlex enrichment that already runs', () => {
  // Half of NASA's records and a tenth of Europe PMC's arrive without one, and a
  // card whose body reads "Resumen no disponible" is dead weight in a feed you
  // navigate by swiping.
  const paper = PaperBuilder.create({ id: 'nasa:1', title: 'A record without an abstract' });
  assert.equal(paper.abstract, 'No abstract available.');

  const merged = PaperBuilder.merge(paper, { abstract: 'The abstract OpenAlex had.' }, 'openalex');
  assert.equal(merged.abstract, 'The abstract OpenAlex had.');
  assert.equal(merged.summary, 'The abstract OpenAlex had.');
});

test('never overwrites an abstract the source already supplied', () => {
  // The publisher's own text beats a rebuild of an inverted index.
  const paper = PaperBuilder.create({ id: 'arxiv:1', abstract: 'The text arXiv shipped.' });
  const merged = PaperBuilder.merge(paper, { abstract: 'The rebuilt OpenAlex one.' }, 'openalex');
  assert.equal(merged.abstract, 'The text arXiv shipped.');
});

test('leaves the placeholder alone when the enrichment has nothing either', () => {
  const paper = PaperBuilder.create({ id: 'nasa:2' });
  assert.equal(PaperBuilder.merge(paper, { abstract: '' }, 'openalex').abstract, 'No abstract available.');
  assert.equal(PaperBuilder.merge(paper, {}, 'openalex').abstract, 'No abstract available.');
  // A placeholder arriving from the other side must not be mistaken for text.
  assert.equal(
    PaperBuilder.merge(paper, { abstract: 'Resumen no disponible.' }, 'openalex').abstract,
    'No abstract available.',
  );
});

test('OpenAlex ids are grafted onto the authors a card already shows, without touching the names', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    sources: { primary: 'arxiv', enrichedBy: [] },
    authors: [
      { name: 'Nicolás Cuello', id: null, affiliation: null },
      { name: 'Mario Sucerquia', id: null, affiliation: null },
    ],
  });

  const merged = PaperBuilder.merge(base, {
    authors: [
      // OpenAlex writes the same people differently, and out of order.
      { name: 'Sucerquia, M.', id: 'https://openalex.org/A2' },
      { name: 'Nicolas Cuello', id: 'https://openalex.org/A1' },
    ],
  }, 'openalex');

  assert.deepEqual(merged.authors, [
    { name: 'Nicolás Cuello', id: 'https://openalex.org/A1', affiliation: null },
    { name: 'Mario Sucerquia', id: 'https://openalex.org/A2', affiliation: null },
  ], 'the card keeps its own spelling and order, and gains the id');
});

test('an author OpenAlex does not name, or does not disambiguate, is left as it was', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Ada Lovelace', id: null }, { name: 'Grace Hopper', id: null }],
  });

  const merged = PaperBuilder.merge(base, {
    authors: [
      { name: 'Ada Lovelace', id: null },
      { name: 'Someone Else', id: 'https://openalex.org/A9' },
    ],
  }, 'openalex');

  assert.deepEqual(merged.authors, [{ name: 'Ada Lovelace', id: null }, { name: 'Grace Hopper', id: null }]);
});

/**
 * Two co-authors sharing a surname and an initial. `matchesAuthorName` lets an
 * initial match any part starting with that letter, so a first-match `find`
 * handed BOTH of them the first "Wang, J." — executed against the real matcher
 * during the 2026-09-09 review — and the id door opened the other person's
 * page with no name check downstream. arXiv and OpenAlex list the same work in
 * the same order, so when the two lists are the same length the position is
 * the identity; otherwise only a UNIQUE name match may carry an id.
 */
test('co-authors sharing a surname get their own ids, by position', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Jing Wang', id: null }, { name: 'Jun Wang', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Wang, J.', id: 'https://openalex.org/A1' }, { name: 'Wang, J.', id: 'https://openalex.org/A2' }],
  }, 'openalex');
  assert.deepEqual(merged.authors.map((a) => (a as PaperAuthor).id), ['https://openalex.org/A1', 'https://openalex.org/A2']);
});

test('when the lists differ in length, an ambiguous name carries no id', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'J. Smith', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [
      { name: 'John Smith', id: 'https://openalex.org/A1' },
      { name: 'Jane Smith', id: 'https://openalex.org/A2' },
      { name: 'Grace Hopper', id: 'https://openalex.org/A3' },
    ],
  }, 'openalex');
  assert.equal((merged.authors[0] as PaperAuthor).id, null, 'two Smiths match: the door stays the slow one rather than the wrong one');
});

test('a position that does not match the name falls back to a unique match', () => {
  // Same length, but OpenAlex lists them in the other order.
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Ada Lovelace', id: null }, { name: 'Grace Hopper', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Hopper, G.', id: 'https://openalex.org/A2' }, { name: 'Lovelace, A.', id: 'https://openalex.org/A1' }],
  }, 'openalex');
  assert.deepEqual(merged.authors.map((a) => (a as PaperAuthor).id), ['https://openalex.org/A1', 'https://openalex.org/A2']);
});

test('an id the paper already carries is never overwritten by the enrichment', () => {
  const base = PaperBuilder.create({
    id: 'openalex:W1',
    authors: [{ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }],
  });

  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'A. Lovelace', id: 'https://openalex.org/A999' }],
  }, 'openalex');

  assert.equal((merged.authors[0] as PaperAuthor).id, 'https://openalex.org/A1');
});

test('a paper that arrives with no authors takes the enrichment list whole', () => {
  const base = PaperBuilder.create({ id: '2609.05134', authors: [] });

  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }],
  }, 'openalex');

  assert.deepEqual(merged.authors, [{ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }]);
});

test('enrichment without authors leaves the list alone', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Ada Lovelace', id: null }],
  });

  const merged = PaperBuilder.merge(base, { citationCount: 4 }, 'openalex');
  assert.deepEqual(merged.authors, [{ name: 'Ada Lovelace', id: null }]);
});

/**
 * The same paper under two OpenAlex records with the first author's name in
 * two orders. Cut from what OpenAlex answered on 2026-09-22 for "segment
 * anything in high quality": the preprint W4379474533 by "Ke Jian Lei" under
 * the arXiv DOI and the NeurIPS paper W7133191568 by "Lei Ke" under the
 * proceedings DOI. Different DOIs, different last name token, one paper --
 * and the search showed it twice.
 */
test('one paper, two records, the first author\'s name in two orders: one result', () => {
  const preprint = {
    id: 'openalex:W4379474533',
    doi: '10.48550/arxiv.2306.01567',
    arxivId: '2306.01567',
    title: 'Segment Anything in High Quality',
    authors: [{ name: 'Ke Jian Lei' }, { name: 'Mingqiao Ye' }, { name: 'Martin Danelljan' }],
    year: 2023,
    publicationStatus: 'preprint' as const,
    publicationType: 'preprint',
    citationsCount: 110,
    provider: 'openalex_search',
    sources: { primary: 'openalex', enrichedBy: [] },
  };
  const conference = {
    id: 'openalex:W7133191568',
    doi: '10.52202/075280-1303',
    title: 'Segment Anything in High Quality',
    authors: [{ name: 'Lei Ke' }, { name: 'Mingqiao Ye' }, { name: 'Martin Danelljan' }],
    year: 2023,
    publicationStatus: 'published' as const,
    publicationType: 'conference-paper',
    citationsCount: 85,
    provider: 'openalex_search',
    sources: { primary: 'openalex', enrichedBy: [] },
  };

  const out = PaperBuilder.deduplicate([preprint, conference]);
  assert.equal(out.length, 1);
  assert.equal(out[0].arxivId, '2306.01567', 'keeps the arXiv id of the preprint');
  assert.equal(out[0].publicationStatus, 'published', 'and the published status of the conference paper');
  assert.equal(out[0].citationCount, 110, 'the larger count wins');
});

test('the order-blind author key is not issued for a title too short to be a fingerprint', () => {
  // Two editorials by two people who share a given name are two papers.
  const out = PaperBuilder.deduplicate([
    { id: 'a', title: 'Editorial', authors: [{ name: 'Wei Zhang' }], provider: 'openalex' },
    { id: 'b', title: 'Editorial', authors: [{ name: 'Li Wei' }], provider: 'openalex' },
  ]);
  assert.equal(out.length, 2);
});

test('a shared token is required: an identical long title by unrelated authors stays two papers', () => {
  const out = PaperBuilder.deduplicate([
    { id: 'a', title: 'A Comprehensive Survey of Graph Neural Networks', authors: [{ name: 'Ada Lovelace' }], provider: 'openalex' },
    { id: 'b', title: 'A Comprehensive Survey of Graph Neural Networks', authors: [{ name: 'Grace Hopper' }], provider: 'pubmed' },
  ]);
  assert.equal(out.length, 2);
});

test('initials never bridge: "J. Smith" and "Smith J." meet on the surname, not on the letter', () => {
  const out = PaperBuilder.deduplicate([
    { id: 'a', title: 'A Comprehensive Survey of Graph Neural Networks', authors: [{ name: 'J. Smith' }], provider: 'openalex' },
    { id: 'b', title: 'A Comprehensive Survey of Graph Neural Networks', authors: [{ name: 'Smith J.' }], provider: 'pubmed' },
    { id: 'c', title: 'A Comprehensive Survey of Graph Neural Networks', authors: [{ name: 'J. Doe' }], provider: 'pubmed' },
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.some(paper => paper.id === 'c'));
});

test('authors given as plain strings still take part in the heuristic keys', () => {
  const out = PaperBuilder.deduplicate([
    { id: 'a', title: 'Segment Anything in High Quality', authors: ['Ke Jian Lei'], provider: 'openalex' },
    { id: 'b', title: 'Segment Anything in High Quality', authors: ['Lei Ke'], provider: 'arxiv' },
  ]);
  assert.equal(out.length, 1);
});

// Also seen live the same day: OpenAlex's "A Comprehensive Survey on Graph
// Neural Networks" once by "Zonghan Wu" with its DOI and once by "Wu, Z" with
// none. The initial is dropped (one letter), the surname joins them.
test('"Zonghan Wu" and "Wu, Z" on one long title are one paper', () => {
  const out = PaperBuilder.deduplicate([
    { id: 'openalex:W2907492528', doi: '10.1109/tnnls.2020.2978386', title: 'A Comprehensive Survey on Graph Neural Networks', authors: [{ name: 'Zonghan Wu' }], provider: 'openalex' },
    { id: 'openalex:W4210257598', title: 'A Comprehensive Survey on Graph Neural Networks', authors: [{ name: 'Wu, Z' }], provider: 'openalex' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].doi, '10.1109/tnnls.2020.2978386');
});
