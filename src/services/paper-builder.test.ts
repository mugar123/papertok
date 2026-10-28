import type { Paper, PaperAuthor } from '../models/paper.ts';
import type { OpenAlexLocation, OpenAlexWork } from './adapters/open-alex-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBuilder } from './paper-builder.ts';
import { mapCrossrefInstitutionWork } from './crossref-institution-service.ts';
import { mapAdsPaper } from './domain-source-records.ts';
import { slimWorksPage } from './open-alex-service.ts';
import { mapOpenAlexEnrichmentWork } from '../utils/open-alex-work.ts';
import { OpenAlexAdapter } from './adapters/open-alex-adapter.ts';
import { PubmedAdapter } from './adapters/pubmed-adapter.ts';
import { searchPapersAcrossSources } from './paper-search-service.ts';
import { SemanticScholarAdapter } from './adapters/semantic-scholar-adapter.ts';
import { scorePaperForRecommendation } from '../utils/recommendation-engine.ts';
import { reviewTagForPaper } from '../utils/paper-status.ts';
import { filterAndSortEntityPapers } from '../utils/entity-explorer.ts';

test('normalizes category and publication metadata used by ranking', () => {
  const paper = PaperBuilder.create({
    id: 'arxiv:2607.00001',
    title: 'Optics paper',
    categories: ['physics.optics', 'quant-ph'],
    published: '2026-07-01T00:00:00Z',
    citationsCount: 12,
    authors: [{ name: 'Ada Researcher' }],
  });

  // No primary is made up for a record that names none (PAP-60); the
  // ranking reads its categories in order.
  assert.equal(paper.primaryCategory, '');
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

// An arXiv or PubMed listing has no citation data: its 0 comes with
// `citationCountKnown: false`. The corpus merges every new listing into the
// stored row, and that turned a count OpenAlex or iCite had confirmed back
// into an unknown one.
test('a record without citation data leaves a confirmed count as it was', () => {
  const listing = () => PaperBuilder.create({
    id: '2610.11111', arxivId: '2610.11111', title: 'Sparse attention for long documents',
    sources: { primary: 'arxiv', enrichedBy: [] },
  });
  for (const count of [0, 12]) {
    const counted = PaperBuilder.merge(listing(), { citationCount: count, citationCountKnown: true }, 'openalex');
    const listedAgain = PaperBuilder.merge(counted, listing(), 'arxiv');
    assert.deepEqual([listedAgain.citationCount, listedAgain.citationCountKnown], [count, true]);
  }
  const [openAlexFirst] = PaperBuilder.deduplicate([
    { id: 'openalex:W1', arxivId: '2610.11111', title: 'Sparse attention for long documents', citationsCount: 0, citationCountKnown: true, sources: { primary: 'openalex', enrichedBy: [] } },
    listing(),
  ]);
  assert.deepEqual([openAlexFirst.citationCount, openAlexFirst.citationCountKnown], [0, true]);
  const neverCounted = PaperBuilder.merge(listing(), listing(), 'arxiv');
  assert.deepEqual([neverCounted.citationCount, neverCounted.citationCountKnown], [0, false]);
});

// Captured from OpenAlex on 2026-10-26 and trimmed: a Nature article of 2018,
// retracted in 2021, with its arXiv eprint among the locations.
const RETRACTED_WORK: OpenAlexWork = {
  id: 'https://openalex.org/W2766253867',
  doi: 'https://doi.org/10.1038/nature26142',
  title: 'RETRACTED ARTICLE: Quantized Majorana conductance',
  type: 'article',
  publication_date: '2018-03-27',
  is_retracted: true,
  primary_location: { landing_page_url: 'https://doi.org/10.1038/nature26142', is_published: true, source: { id: 'https://openalex.org/S137773608', display_name: 'Nature', type: 'journal' } },
  locations: [{ landing_page_url: 'http://arxiv.org/abs/1710.10701', is_published: false, source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' } }],
};

// The corpus merges every later listing into the stored row, and search
// deduplicates its results in the order they arrive.
test('a retraction stands whichever record of the paper comes first', () => {
  const eprint = () => PaperBuilder.create({
    id: '1710.10701', arxivId: '1710.10701', title: 'Quantized Majorana conductance', authors: [{ name: 'Hao Zhang' }],
    sources: { primary: 'arxiv', enrichedBy: [] },
  });
  // Synthetic, in the shape NASA ADS returns: a refereed Nature article.
  const article = () => mapAdsPaper({
    bibcode: '2018Natur.556...74Z', title: ['Quantized Majorana conductance'], author: ['Zhang, Hao'],
    doi: ['10.1038/nature26142'], identifier: ['arXiv:1710.10701'], property: ['REFEREED', 'ARTICLE'],
    doctype: 'article', pub: 'Nature', pubdate: '2018-04-00', year: '2018',
  })!;
  const retraction = mapOpenAlexEnrichmentWork(RETRACTED_WORK)!.enrichment;
  for (const listing of [eprint, article]) {
    const enriched = PaperBuilder.merge(listing(), retraction, 'openalex');
    assert.equal(enriched.publicationStatus, 'retracted', listing().sources.primary);
    assert.equal(PaperBuilder.merge(enriched, listing(), listing().sources.primary).publicationStatus, 'retracted', `${listing().sources.primary} lists it again`);
  }
  // The journal's evidence still counts: the eprint reads as the article it became.
  const enrichedEprint = PaperBuilder.merge(eprint(), retraction, 'openalex');
  assert.deepEqual([enrichedEprint.publicationType, enrichedEprint.peerReviewed], ['article', true]);

  const card = new OpenAlexAdapter().mapToStandard(RETRACTED_WORK)!;
  for (const records of [[card, eprint()], [eprint(), card]]) {
    const merged = PaperBuilder.deduplicate(records);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].publicationStatus, 'retracted', records[0].sources.primary);
  }
});

// A mapper leaves the year out when the provider's date is after today; the
// builder, and `deduplicate` through it, used to write in the current year.
test('a record without a year keeps no year', () => {
  const record = { id: 'pmid:42879010', sources: { primary: 'pubmed', enrichedBy: [] }, title: 'Chapter' };
  assert.equal(PaperBuilder.create(record).year, undefined);
  assert.equal(PaperBuilder.deduplicate([record])[0].year, undefined);
  assert.equal(PaperBuilder.create({ ...record, year: 2025 }).year, 2025);
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

// ENG-123: `venueId` is the OpenAlex id of the journal a record names, and
// travels as the journal's name does: a row fills it from the first record
// that has one, keeps its own, and a working paper that keeps its own `false`
// takes neither the article's journal nor its id.
test("a row keeps the OpenAlex id of its journal as it keeps the journal's name", () => {
  const preprint = PaperBuilder.create({ id: '2610.11111', arxivId: '2610.11111', sources: { primary: 'arxiv', enrichedBy: [] }, title: 'Monetary policy and the term structure' });
  assert.equal(preprint.venueId, undefined);
  const article = PaperBuilder.create({
    id: 'openalex:W7000000001', sources: { primary: 'openalex', enrichedBy: [] }, title: 'Monetary policy and the term structure',
    journal: 'American Economic Review', venueId: 'S23254222', publicationType: 'article', publicationStatus: 'published',
  });
  assert.equal(article.venueId, 'S23254222');
  assert.equal(PaperBuilder.merge(preprint, article, 'openalex').venueId, 'S23254222');
  assert.equal(PaperBuilder.merge({ ...preprint, venueId: 'S1' }, article, 'openalex').venueId, 'S1');

  const workingPaper = {
    id: 'openalex:W200', sources: { primary: 'openalex', enrichedBy: [] }, doi: '10.5089/9798229063456.001',
    title: 'Monetary policy and bank lending in small open economies', authors: [{ name: 'Ana Economist' }],
    publicationType: 'article', publicationStatus: 'published' as const, peerReviewed: false, workingPaper: true, provider: 'openalex',
  };
  const [row] = PaperBuilder.deduplicate([workingPaper, {
    ...workingPaper, id: 'openalex:W201', doi: '10.1016/j.jinteco.2026.103900', peerReviewed: true, workingPaper: undefined,
    journal: 'Journal of International Economics', venueId: 'S99999999',
  }]);
  assert.deepEqual([row.id, row.journal, row.venueId], ['openalex:W200', undefined, undefined]);
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
    // A topic asks arXiv for its category listing and for its query
    // (`fetchTopicPapers`), and two followed authors can both list the eprint,
    // so the arXiv record can merge a copy of itself first.
    ['topic, arXiv copy first', PaperBuilder.deduplicate([arxiv, arxiv, searchRecord()])],
    ['Explorer page, arXiv copy first', PaperBuilder.deduplicate([arxiv, arxiv, explorerRecord()])],
    ['feed enrichment after an arXiv copy', [PaperBuilder.merge(PaperBuilder.deduplicate([arxiv, arxiv])[0], mapOpenAlexEnrichmentWork(fedsWork)!.enrichment, 'openalex')]],
    // The followed feed deduplicates a name-only author's arXiv records with
    // a followed topic's rows, which `fetchTopicPapers` has already merged.
    ['followed, author arXiv record before a topic row', PaperBuilder.deduplicate([arxiv, ...PaperBuilder.deduplicate([arxiv, searchRecord()])])],
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

  // A third record can merge in between. OpenAlex also files the eprint as a
  // preprint under arXiv's own DOI. That record says nothing about review, so
  // the revision's DOI stays the arXiv record's only claim and the row is
  // still the FEDS paper. OpenAlex's record of a journal article under the
  // DOI arXiv lists does say the paper was reviewed, and the row stays so.
  const arxivLocation = {
    landing_page_url: `https://arxiv.org/abs/${arxivId}`,
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
  const preprintWork: OpenAlexWork = {
    id: 'https://openalex.org/W501',
    doi: `https://doi.org/10.48550/arXiv.${arxivId}`,
    title,
    type: 'preprint',
    authorships: fedsWork.authorships,
    publication_year: 2026,
    primary_location: arxivLocation,
    locations: [arxivLocation],
  };
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const articleLocation = {
    landing_page_url: `https://doi.org/${journalDoi}`,
    is_published: true,
    source: { id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal', host_organization_name: 'Elsevier' },
  };
  const articleWork: OpenAlexWork = {
    ...preprintWork,
    id: 'https://openalex.org/W502',
    doi: `https://doi.org/${journalDoi}`,
    type: 'article',
    primary_location: articleLocation,
    locations: [articleLocation, arxivLocation],
  };
  const throughSecondRecord = (arxiv: Paper, second: OpenAlexWork): Array<[string, Paper[]]> => {
    const explorer = (work: OpenAlexWork) => slimWorksPage({ results: [work] }).papers[0];
    const enrichment = (work: OpenAlexWork) => mapOpenAlexEnrichmentWork(work)!.enrichment;
    return [
      ['search', PaperBuilder.deduplicate([arxiv, new OpenAlexAdapter().mapToStandard(second)!, searchRecord()])],
      ['Explorer page', PaperBuilder.deduplicate([arxiv, explorer(second), explorerRecord()])],
      ['Explorer across pages', [arxiv, explorer(second), explorerRecord()]
        .reduce<Paper[]>((rows, record) => PaperBuilder.deduplicate([...rows, record]), [])],
      ['feed enrichment', [PaperBuilder.merge(PaperBuilder.merge(arxiv, enrichment(second), 'openalex'), enrichment(fedsWork), 'openalex')]],
      ['followed, author arXiv record before a topic row', PaperBuilder.deduplicate([
        arxiv, ...PaperBuilder.deduplicate([arxiv, new OpenAlexAdapter().mapToStandard(second)!, searchRecord()]),
      ])],
    ];
  };
  for (const [flow, rows] of throughSecondRecord(arxivRecord(`${fedsDoi}r1`), preprintWork)) {
    const where = `OpenAlex preprint between, ${flow}`;
    assert.equal(rows.length, 1, where);
    assert.equal(rows[0].peerReviewed, false, where);
    assert.equal(reviewTagForPaper(rows[0])?.label, 'Working paper', where);
    assert.deepEqual(peerReviewedOnly(rows), [], where);
  }
  // OpenAlex also files the eprint among the journal version's locations,
  // under the journal's DOI. That record's `true` is about its own DOI, not
  // the revision's that the row keeps, so the row is still the FEDS paper.
  for (const [flow, rows] of throughSecondRecord(arxivRecord(`${fedsDoi}r1`), articleWork)) {
    const where = `OpenAlex article under another DOI between, ${flow}`;
    assert.equal(rows.length, 1, where);
    assert.equal(rows[0].doi, `${fedsDoi}r1`, where);
    assert.equal(rows[0].peerReviewed, false, where);
    assert.equal(reviewTagForPaper(rows[0])?.label, 'Working paper', where);
    assert.deepEqual(peerReviewedOnly(rows), [], where);
  }
  // Nor does another provider's record of the journal version: the Explorer
  // falls back to Crossref for an institution and asks Semantic Scholar for a
  // name-only author. Crossref's record joins on title and first author,
  // Semantic Scholar's on the arXiv id.
  const otherArticles: Array<[string, () => Paper]> = [
    ['Crossref', () => mapCrossrefInstitutionWork({
      DOI: journalDoi,
      title: [title],
      type: 'journal-article',
      author: [{ given: 'Ana', family: 'Economist' }],
      'container-title': ['Journal of International Economics'],
      publisher: 'Elsevier',
    })!],
    ['Semantic Scholar', () => new SemanticScholarAdapter().mapToStandard({
      paperId: 'e'.repeat(40),
      title,
      authors: [{ name: 'Ana Economist', authorId: '1' }],
      venue: 'Journal of International Economics',
      externalIds: { DOI: journalDoi, ArXiv: arxivId },
    })],
  ];
  for (const [provider, article] of otherArticles) {
    const arxiv = arxivRecord(`${fedsDoi}r1`);
    const otherFlows: Array<[string, Paper[]]> = [
      ['Explorer page', PaperBuilder.deduplicate([arxiv, article(), explorerRecord()])],
      ['Explorer across pages', [arxiv, article(), explorerRecord()]
        .reduce<Paper[]>((rows, record) => PaperBuilder.deduplicate([...rows, record]), [])],
    ];
    for (const [flow, rows] of otherFlows) {
      const where = `${provider} article under another DOI between, ${flow}`;
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi, `${fedsDoi}r1`, where);
      assert.equal(rows[0].peerReviewed, false, where);
      assert.equal(reviewTagForPaper(rows[0])?.label, 'Working paper', where);
      assert.deepEqual(peerReviewedOnly(rows), [], where);
    }
  }
  for (const [flow, rows] of throughSecondRecord(arxivRecord(journalDoi), articleWork)) {
    const where = `OpenAlex article between, ${flow}`;
    assert.equal(rows.length, 1, where);
    assert.equal(rows[0].doi, journalDoi, where);
    assert.equal(rows[0].peerReviewed, true, where);
    assert.equal(reviewTagForPaper(rows[0]), null, where);
    assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], where);
  }

  // The same eprint published in a journal, which arXiv records with the
  // journal's DOI and reference, stays reviewed when it arrives first.
  for (const [flow, rows] of flows(arxivRecord(journalDoi, 'J. Int. Econ. 160 (2026) 103900'), { workingPaperFirst: false })) {
    assert.equal(rows.length, 1, flow);
    assert.equal(rows[0].doi, journalDoi, flow);
    assert.equal(rows[0].peerReviewed, true, flow);
    assert.equal(reviewTagForPaper(rows[0]), null, flow);
    assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], flow);
  }
  // An arXiv record that names the journal backs a row whose `true` rested on
  // the DOI alone, as OpenAlex's article does; a copy without it does not.
  const [referenced] = PaperBuilder.deduplicate([
    arxivRecord(journalDoi), arxivRecord(journalDoi, 'J. Int. Econ. 160 (2026) 103900'), searchRecord(),
  ]);
  assert.equal(referenced.peerReviewed, true);
  assert.equal(reviewTagForPaper(referenced), null);

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
  const nberSource = { id: 'S2809516038', display_name: 'National Bureau of Economic Research', type: 'repository' };
  const flows = (arxiv: Paper, work: OpenAlexWork): Array<[string, Paper[]]> => {
    const explorerPage = PaperBuilder.deduplicate([arxiv, slimWorksPage({ results: [work] }).papers[0]]);
    return [
      ['search', PaperBuilder.deduplicate([arxiv, new OpenAlexAdapter().mapToStandard(work)!])],
      ['topic, arXiv copy first', PaperBuilder.deduplicate([arxiv, arxiv, new OpenAlexAdapter().mapToStandard(work)!])],
      ['Explorer page', explorerPage],
      ['Explorer across pages', PaperBuilder.deduplicate([...PaperBuilder.deduplicate([arxiv]), slimWorksPage({ results: [work] }).papers[0]])],
      // Each further page deduplicates the rows already shown again.
      ['Explorer, a later page', PaperBuilder.deduplicate(explorerPage)],
      // The feed asks followed authors and institutions in random order, so a
      // second author's copy of the eprint can follow the institution's work.
      ['followed, arXiv copy last', PaperBuilder.deduplicate([arxiv, slimWorksPage({ results: [work] }).papers[0], arxiv])],
      // A name-only author's arXiv record before a topic row that already
      // merged the working paper.
      ['followed, arXiv record before a topic row', PaperBuilder.deduplicate([arxiv, ...PaperBuilder.deduplicate([arxiv, new OpenAlexAdapter().mapToStandard(work)!])])],
      ['feed enrichment', [PaperBuilder.merge(arxiv, mapOpenAlexEnrichmentWork(work)!.enrichment, 'openalex')]],
    ];
  };
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

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

  // A DOI alone does not say which work it is: a journal's, the paper's own
  // SSRN entry, or the NBER paper itself when OpenAlex's NBER record has no
  // DOI. Beside a working paper that shares the eprint, the answer is
  // unknown: neither the DOI's `true` nor the working paper's `false`.
  for (const [label, doi, work] of [
    ['journal DOI, FEDS', journalDoi, feds],
    ['SSRN DOI, NBER', '10.2139/ssrn.4400000', workingPaperWork('10.3386/w31999', nberSource, 'report')],
    ['NBER DOI, NBER without a DOI', '10.3386/w30000', workingPaperWork(null, nberSource, 'report')],
  ] as Array<[string, string, OpenAlexWork]>) {
    for (const [flow, rows] of flows(arxivRecord(doi), work)) {
      const where = `${label}, ${flow}`;
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi, doi, where);
      assert.equal(rows[0].peerReviewed, undefined, where);
      assert.equal(reviewTagForPaper(rows[0]), null, where);
      assert.equal(rows[0].journal, undefined, where);
      assert.deepEqual(peerReviewedOnly(rows), [], where);
    }
  }

  // OpenAlex's record of the journal version, which lists the eprint too,
  // answers for an unknown row only under the DOI the row shows.
  const articleLocation = {
    landing_page_url: `https://doi.org/${journalDoi}`,
    is_published: true,
    source: { id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal' },
  };
  const article: OpenAlexWork = {
    ...feds,
    id: 'https://openalex.org/W601',
    doi: `https://doi.org/${journalDoi}`,
    primary_location: articleLocation,
    locations: [articleLocation, feds.locations![1]],
  };
  const search = (work: OpenAlexWork) => new OpenAlexAdapter().mapToStandard(work)!;
  const explorer = (work: OpenAlexWork) => slimWorksPage({ results: [work] }).papers[0];
  const enrichment = (work: OpenAlexWork) => mapOpenAlexEnrichmentWork(work)!.enrichment;
  for (const [label, doi, work, answer] of [
    ['journal DOI, FEDS', journalDoi, feds, true],
    ['SSRN DOI, NBER', '10.2139/ssrn.4400000', workingPaperWork('10.3386/w31999', nberSource, 'report'), undefined],
    ['NBER DOI, NBER without a DOI', '10.3386/w30000', workingPaperWork(null, nberSource, 'report'), undefined],
  ] as Array<[string, string, OpenAlexWork, boolean | undefined]>) {
    const arxiv = arxivRecord(doi);
    const articleLast: Array<[string, Paper[]]> = [
      ['search', PaperBuilder.deduplicate([arxiv, search(work), search(article)])],
      ['Explorer page', PaperBuilder.deduplicate([arxiv, explorer(work), explorer(article)])],
      ['Explorer across pages', [arxiv, explorer(work), explorer(article)]
        .reduce<Paper[]>((rows, record) => PaperBuilder.deduplicate([...rows, record]), [])],
      ['feed enrichment', [PaperBuilder.merge(PaperBuilder.merge(arxiv, enrichment(work), 'openalex'), enrichment(article), 'openalex')]],
      ['followed, arXiv record before a topic row', PaperBuilder.deduplicate([arxiv, ...PaperBuilder.deduplicate([arxiv, search(work), search(article)])])],
    ];
    for (const [flow, rows] of articleLast) {
      const where = `${label}, journal article last, ${flow}`;
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi, doi, where);
      assert.equal(rows[0].peerReviewed, answer, where);
      assert.equal(peerReviewedOnly(rows).length, answer ? 1 : 0, where);
    }
  }
});

test('a row merged again keeps the answer its first merge gave it', () => {
  // Synthetic records through the real mappers. The followed feed
  // deduplicates the candidates of several follows together, and a followed
  // topic's candidates are rows `fetchTopicPapers` has already merged. A
  // topic with an OpenAlex id lists OpenAlex's works first, its record of the
  // eprint under arXiv's DOI among them; one without asks arXiv first.
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivId = '2601.00007';
  const arxivLocation = {
    landing_page_url: `https://arxiv.org/abs/${arxivId}`,
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
  const openAlexRecord = (id: string, doi: string | null, type: string, location: typeof arxivLocation | {
    landing_page_url: string;
    is_published: boolean;
    source: { id: string; display_name: string; type: string; host_organization_name?: string };
  }) => slimWorksPage({ results: [{
    id: `https://openalex.org/${id}`,
    doi: doi ? `https://doi.org/${doi}` : null,
    title,
    type,
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
    publication_year: 2026,
    primary_location: location,
    locations: location === arxivLocation ? [arxivLocation] : [location, arxivLocation],
  }] }).papers[0];
  const fedsDoi = '10.17016/FEDS.2026.007';
  const feds = () => openAlexRecord('W700', fedsDoi, 'article', {
    landing_page_url: `https://doi.org/${fedsDoi}`,
    is_published: true,
    source: {
      id: 'https://openalex.org/S4210212089',
      display_name: 'Finance and Economics Discussion Series',
      type: 'journal',
      host_organization_name: 'Board of Governors of the Federal Reserve System',
    },
  });
  const nberSource = { id: 'https://openalex.org/S2809516038', display_name: 'National Bureau of Economic Research', type: 'repository' };
  const nber = () => openAlexRecord('W701', '10.3386/w31999', 'report', {
    landing_page_url: 'https://doi.org/10.3386/w31999', is_published: true, source: nberSource,
  });
  const nberWithoutDoi = () => openAlexRecord('W702', null, 'report', {
    landing_page_url: 'https://www.nber.org/papers/w30000', is_published: true, source: nberSource,
  });
  const preprint = () => openAlexRecord('W703', `10.48550/arXiv.${arxivId}`, 'preprint', arxivLocation);
  // As `arxivService` maps an entry with a DOI and no journal reference.
  const arxivRecord = (doi: string) => PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi,
    publicationType: 'article',
    publicationStatus: 'published',
  });
  const flows = (arxiv: Paper, workingPaper: () => Paper): Array<[string, Paper[]]> => [
    // A topic row holding only OpenAlex's preprint record, then a topic row
    // that merged the arXiv record and the working paper.
    ['preprint row, then a row with the working paper', PaperBuilder.deduplicate([
      ...PaperBuilder.deduplicate([preprint()]),
      ...PaperBuilder.deduplicate([arxiv, workingPaper()]),
    ])],
    // A name-only author's arXiv record, a topic row that merged OpenAlex's
    // preprint record before the same arXiv record, then an institution's
    // working paper.
    ['arXiv record, a row that began as the preprint record, working paper', PaperBuilder.deduplicate([
      arxiv, ...PaperBuilder.deduplicate([preprint(), arxiv]), workingPaper(),
    ])],
    // The arXiv record beside a row that took the working paper's answer
    // through OpenAlex's preprint record.
    ['arXiv record, a preprint row that merged the working paper', PaperBuilder.deduplicate([
      arxiv, ...PaperBuilder.deduplicate([preprint(), ...PaperBuilder.deduplicate([arxiv, workingPaper()])]),
    ])],
  ];
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  // Each row reads as it does after its first merge: the FEDS revision as
  // the FEDS paper, the other DOIs as unknown.
  for (const [label, doi, workingPaper, expected] of [
    ['FEDS revision, FEDS', `${fedsDoi}r1`, feds, false],
    ['journal DOI, FEDS', '10.1016/j.jinteco.2026.103900', feds, undefined],
    ['SSRN DOI, NBER', '10.2139/ssrn.4400000', nber, undefined],
    ['NBER DOI, NBER without a DOI', '10.3386/w30000', nberWithoutDoi, undefined],
  ] as Array<[string, string, () => Paper, false | undefined]>) {
    for (const [flow, rows] of flows(arxivRecord(doi), workingPaper)) {
      const where = `${label}, ${flow}`;
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].peerReviewed, expected, where);
      assert.equal(reviewTagForPaper(rows[0])?.label ?? null, expected === false ? 'Working paper' : null, where);
      assert.deepEqual(peerReviewedOnly(rows), [], where);
    }
  }
});

test('a working paper joined on title alone keeps a DOI-only arXiv row out of "Peer-reviewed only" after a preprint row', () => {
  // Synthetic records through the real mappers. OpenAlex can file a working
  // paper without the eprint among its locations, so `deduplicate` joins it
  // with OpenAlex's record of the eprint on title and first author only. The
  // followed feed puts a name-only author's arXiv record before a topic row
  // that merged the two, and search deduplicates the feed's card with its own
  // OpenAlex-then-arXiv row.
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivId = '2601.00007';
  const arxivLocation = {
    landing_page_url: `https://arxiv.org/abs/${arxivId}`,
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
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
  const work = (id: string, doi: string, type: string, location: typeof fedsLocation | typeof arxivLocation): OpenAlexWork => ({
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/${doi}`,
    title,
    type,
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
    publication_year: 2026,
    primary_location: location,
    locations: [location],
  });
  const fedsWork = work('W700', fedsDoi, 'article', fedsLocation);
  const preprintWork = work('W703', `10.48550/arXiv.${arxivId}`, 'preprint', arxivLocation);
  const explorer = (record: OpenAlexWork) => slimWorksPage({ results: [record] }).papers[0];
  const search = (record: OpenAlexWork) => new OpenAlexAdapter().mapToStandard(record)!;
  // As `arxivService` maps an entry with a DOI and no journal reference.
  const arxivRecord = (doi: string) => PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi,
    publicationType: 'article',
    publicationStatus: 'published',
  });
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  for (const doi of [`${fedsDoi}r1`, '10.2139/ssrn.4400000']) {
    const arxiv = arxivRecord(doi);
    for (const [flow, rows] of [
      ['followed, arXiv record before a topic row', PaperBuilder.deduplicate([
        arxiv, ...PaperBuilder.deduplicate([explorer(preprintWork), explorer(fedsWork)]),
      ])],
      ['search, feed card before the search row', PaperBuilder.deduplicate([
        arxiv, ...PaperBuilder.deduplicate([search(preprintWork), search(fedsWork), arxiv]),
      ])],
    ] as Array<[string, Paper[]]>) {
      const where = `${doi}, ${flow}`;
      assert.equal(rows.length, 1, where);
      assert.notEqual(rows[0].peerReviewed, true, where);
      assert.deepEqual(peerReviewedOnly(rows), [], where);
    }
  }
});

test('a working paper\'s `false` left off a row keeps a later DOI-only arXiv `true` from reading reviewed', async () => {
  // Synthetic records through the real mappers. OpenAlex leaves a journal DOI
  // without a source, or a series it does not list, unknown, and a working
  // paper on the same eprint that the row is not leaves it so. Search lists
  // OpenAlex's works before arXiv's records, and the followed feed can put an
  // OpenAlex author's works, or a topic row that joined them, before a
  // name-only author's arXiv record. That record's only claim is a DOI.
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivId = '2601.00007';
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const arxivLocation = {
    landing_page_url: `https://arxiv.org/abs/${arxivId}`,
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
  const work = (id: string, doi: string, type: string, source: OpenAlexLocation['source']): OpenAlexWork => {
    const location = { landing_page_url: `https://doi.org/${doi}`, is_published: true, source };
    return {
      id: `https://openalex.org/${id}`,
      doi: `https://doi.org/${doi}`,
      title,
      type,
      authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
      publication_year: 2026,
      primary_location: location,
      locations: [location, arxivLocation],
    };
  };
  const noSource = work('W507', journalDoi, 'article', null);
  const ecb = work('W520', '10.2866/402116', 'article', {
    id: 'https://openalex.org/S4210190871', display_name: 'ECB Working Paper Series', type: 'journal', host_organization_name: 'European Central Bank',
  });
  const feds = work('W500', '10.17016/FEDS.2026.007', 'article', {
    id: 'https://openalex.org/S4210212089',
    display_name: 'Finance and Economics Discussion Series',
    type: 'journal',
    host_organization_name: 'Board of Governors of the Federal Reserve System',
  });
  const nber = work('W508', '10.3386/w31999', 'report', {
    id: 'https://openalex.org/S2809516038', display_name: 'National Bureau of Economic Research', type: 'repository',
  });
  // As `arxivService` maps an entry with a DOI and no journal reference.
  const arxivRecord = (doi: string) => PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi,
    publicationType: 'article',
    publicationStatus: 'published',
  });
  const search = (record: OpenAlexWork) => new OpenAlexAdapter().mapToStandard(record)!;
  const explorer = (record: OpenAlexWork) => slimWorksPage({ results: [record] }).papers[0];
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  // The arXiv record's DOI is another version's or the row's own. Either way
  // it says no more than the DOI, so the answer stays unknown in every order,
  // as it already did with the arXiv record before the working paper.
  for (const [label, unknown, workingPaper, doi] of [
    ['journal DOI without a source, FEDS paper, FEDS revision', noSource, feds, '10.17016/FEDS.2026.007r1'],
    ['journal DOI without a source, NBER paper, SSRN DOI', noSource, nber, '10.2139/ssrn.4400000'],
    ['journal DOI without a source, FEDS paper, the same journal DOI', noSource, feds, journalDoi],
    ['ECB series paper, NBER paper, SSRN DOI', ecb, nber, '10.2139/ssrn.4400000'],
  ] as Array<[string, OpenAlexWork, OpenAlexWork, string]>) {
    const arxiv = arxivRecord(doi);
    const searched = await searchPapersAcrossSources(title, {
      providers: {
        searchOpenAlex: async () => ({ papers: [search(unknown), search(workingPaper)] }),
        searchArxiv: async () => [arxiv],
      },
    });
    for (const [flow, rows] of [
      ['search', searched],
      ['followed, an OpenAlex author before an arXiv author', PaperBuilder.deduplicate([explorer(unknown), explorer(workingPaper), arxiv])],
      ['followed, a topic row before an arXiv author', PaperBuilder.deduplicate([
        ...PaperBuilder.deduplicate([explorer(unknown), explorer(workingPaper)]), arxiv,
      ])],
      ['arXiv record before the working paper', PaperBuilder.deduplicate([search(unknown), arxiv, search(workingPaper)])],
    ] as Array<[string, Paper[]]>) {
      const where = `${label}, ${flow}`;
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi, unknown.doi!.replace('https://doi.org/', ''), where);
      assert.equal(rows[0].peerReviewed, undefined, where);
      assert.equal(reviewTagForPaper(rows[0]), null, where);
      assert.deepEqual(peerReviewedOnly(rows), [], where);
    }
  }

  // A topic with an OpenAlex id lists only OpenAlex's works, so its row can
  // join OpenAlex's journal article and the working paper, which both list
  // the eprint. The followed feed then puts the arXiv record before that row,
  // which keeps the arXiv record's DOI: the article confirms only its own.
  const article = work('W502', journalDoi, 'article', {
    id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal', host_organization_name: 'Elsevier',
  });
  for (const [doi, workingPaper, answer] of [
    ['10.17016/FEDS.2026.007r1', feds, undefined],
    ['10.2139/ssrn.4400000', nber, undefined],
    [journalDoi, feds, true],
  ] as Array<[string, OpenAlexWork, true | undefined]>) {
    for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
      const where = `${doi}, followed, an arXiv author before a topic row (${mapper})`;
      const rows = PaperBuilder.deduplicate([arxivRecord(doi), ...PaperBuilder.deduplicate([map(article), map(workingPaper)])]);
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi, doi, where);
      assert.equal(rows[0].peerReviewed, answer, where);
      assert.equal(peerReviewedOnly(rows).length, answer ? 1 : 0, where);
    }
  }
});

test('a journal record under the row\'s DOI keeps the row reviewed beside a working paper\'s `false`', () => {
  // Synthetic records through the real mappers. OpenAlex files the eprint
  // among the locations of the journal article, of the working paper and of
  // the paper's SSRN entry, so `deduplicate` joins them on the arXiv id.
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivId = '2601.00007';
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const fedsDoi = '10.17016/FEDS.2026.007';
  const arxivLocation = {
    landing_page_url: `https://arxiv.org/abs/${arxivId}`,
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
  const work = (id: string, doi: string, type: string, source: OpenAlexLocation['source'], isPublished = true): OpenAlexWork => {
    const location = { landing_page_url: `https://doi.org/${doi}`, is_published: isPublished, source };
    return {
      id: `https://openalex.org/${id}`,
      doi: `https://doi.org/${doi}`,
      title,
      type,
      authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
      publication_year: 2026,
      primary_location: location,
      locations: [location, arxivLocation],
    };
  };
  const article = work('W502', journalDoi, 'article', {
    id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal', host_organization_name: 'Elsevier',
  });
  const ssrn = work('W513', '10.2139/ssrn.4400000', 'preprint', {
    id: 'https://openalex.org/S4210172589', display_name: 'SSRN Electronic Journal', type: 'repository', host_organization_name: 'RELX Group',
  }, false);
  const conference = work('W505', '10.1145/3600000.3600001', 'article', {
    id: 'https://openalex.org/S222', display_name: 'ACM Economics and Computation', type: 'conference', host_organization_name: 'ACM',
  });
  const nber = work('W508', '10.3386/w31999', 'report', {
    id: 'https://openalex.org/S2809516038', display_name: 'National Bureau of Economic Research', type: 'repository',
  });
  const feds = work('W500', fedsDoi, 'article', {
    id: 'https://openalex.org/S4210212089',
    display_name: 'Finance and Economics Discussion Series',
    type: 'journal',
    host_organization_name: 'Board of Governors of the Federal Reserve System',
  });
  const preprint: OpenAlexWork = {
    ...article,
    id: 'https://openalex.org/W501',
    doi: `https://doi.org/10.48550/arXiv.${arxivId}`,
    type: 'preprint',
    primary_location: arxivLocation,
    locations: [arxivLocation],
  };
  // As `arxivService` maps an entry with a DOI and no journal reference.
  const arxivRecord = (doi: string) => PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi,
    publicationType: 'article',
    publicationStatus: 'published',
  });
  const semanticScholarArticle = () => new SemanticScholarAdapter().mapToStandard({
    paperId: 'e'.repeat(40),
    title,
    authors: [{ name: 'Ana Economist', authorId: '1' }],
    venue: 'Journal of International Economics',
    year: 2026,
    externalIds: { DOI: journalDoi, ArXiv: arxivId },
  });
  const search = (record: OpenAlexWork) => new OpenAlexAdapter().mapToStandard(record)!;
  const explorer = (record: OpenAlexWork) => slimWorksPage({ results: [record] }).papers[0];
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  // The followed feed puts a name-only author's arXiv record before a topic
  // row that joined the SSRN entry, the journal article and a working paper.
  // The topic row shows the SSRN DOI, but its `true` is the article's. The
  // merged row shows the journal's DOI, so the article confirms it. Under
  // the FEDS revision's DOI the `true` is still another version's. The topic
  // row can also begin as the conference version OpenAlex lists under an ACM
  // DOI: it reads `true` under that DOI, and the article in it still confirms
  // the journal's.
  for (const [doi, answer] of [[journalDoi, true], [`${fedsDoi}r1`, undefined]] as Array<[string, true | undefined]>) {
    for (const [label, workingPaper] of [['NBER', nber], ['FEDS', feds]] as const) {
      for (const [began, first] of [['the SSRN entry', ssrn], ['the conference version', conference]] as const) {
        for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
          const where = `${doi}, ${label}, followed, an arXiv author before a topic row that began as ${began} (${mapper})`;
          const rows = PaperBuilder.deduplicate([arxivRecord(doi), ...PaperBuilder.deduplicate([map(first), map(article), map(workingPaper)])]);
          assert.equal(rows.length, 1, where);
          assert.equal(rows[0].doi, doi, where);
          assert.equal(rows[0].peerReviewed, answer, where);
          assert.equal(peerReviewedOnly(rows).length, answer ? 1 : 0, where);
        }
      }
    }
  }

  // The working paper can also come from another follow, before a topic row
  // that began as an arXiv record listing the FEDS revision's DOI and joined
  // the article. That row shows the revision's DOI, and both arXiv records'
  // `true` rests on a DOI alone, but the article in it confirms the journal
  // DOI the merged row shows.
  for (const [label, workingPaper] of [['NBER', nber], ['FEDS', feds]] as const) {
    for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
      const where = `${label}, followed, an arXiv author and the working paper before a topic row that began as an arXiv record (${mapper})`;
      const rows = PaperBuilder.deduplicate([
        arxivRecord(journalDoi), map(workingPaper), ...PaperBuilder.deduplicate([arxivRecord(`${fedsDoi}r1`), map(article)]),
      ]);
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi, journalDoi, where);
      assert.equal(rows[0].peerReviewed, true, where);
      assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], where);
    }
  }

  // Search deduplicates the reader's cards before its own rows. A card from
  // OpenAlex's record of the journal DOI without a source can come first,
  // then a followed row: a topic row that began as the working paper and
  // joined the journal article reads `false` under the working paper's DOI,
  // and one that put an arXiv record listing the FEDS revision's DOI before
  // a topic row with the article and the working paper reads unknown under
  // the revision's DOI. The merged row shows the journal's DOI, which the
  // article confirms. PubMed's record of the article gives no answer of its
  // own; its publication type is a journal article's.
  const noSource = work('W507', journalDoi, 'article', null);
  const pubmedArticle = () => new PubmedAdapter().mapToStandard({
    uid: '40000001',
    title,
    authors: [{ name: 'Economist A' }],
    articleids: [{ idtype: 'doi', value: journalDoi }],
    source: 'J Int Econ',
    pubdate: '2026 Jan',
    pubtype: ['Journal Article'],
  });
  for (const [label, workingPaper] of [['NBER', nber], ['FEDS', feds]] as const) {
    for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
      for (const [kind, followed, answer] of [
        ['a topic row', PaperBuilder.deduplicate([map(workingPaper), map(article)]), false],
        ['a topic row with PubMed\'s record of the article', PaperBuilder.deduplicate([map(workingPaper), pubmedArticle()]), false],
        ['an arXiv record before a topic row', PaperBuilder.deduplicate([
          arxivRecord(`${fedsDoi}r1`), ...PaperBuilder.deduplicate([map(article), map(workingPaper)]),
        ]), undefined],
      ] as Array<[string, Paper[], false | undefined]>) {
        const where = `${label}, an OpenAlex card without a source before ${kind} (${mapper})`;
        assert.equal(followed[0].peerReviewed, answer, where);
        const rows = PaperBuilder.deduplicate([map(noSource), ...followed]);
        assert.equal(rows.length, 1, where);
        assert.equal(rows[0].doi, journalDoi, where);
        assert.equal(rows[0].peerReviewed, true, where);
        assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], where);
      }
    }
  }

  // The row begins as the journal article. A row that joined OpenAlex's
  // preprint record with Semantic Scholar's record of the article reads
  // `false`, published under the preprint's type, which reopens the
  // article's answer. A later record leaves that answer as it was: an arXiv
  // record that lists only the FEDS revision's DOI gives the `true` the
  // article already gave, and OpenAlex's record of the journal DOI without a
  // source gives none.
  for (const [last, record] of [
    ['an arXiv record', () => arxivRecord(`${fedsDoi}r1`)],
    ['OpenAlex without a source', map => map(noSource)],
  ] as Array<[string, (map: (record: OpenAlexWork) => Paper) => Paper]>) {
    for (const [flow, rows] of [
      ['deduplicate', PaperBuilder.deduplicate([
        search(article), ...PaperBuilder.deduplicate([search(preprint), semanticScholarArticle()]), record(search),
      ])],
      // The Explorer deduplicates each page with the rows already shown.
      ['Explorer across pages', [[explorer(article)], [explorer(preprint), semanticScholarArticle()], [record(explorer)]]
        .reduce<Paper[]>((rows, page) => PaperBuilder.deduplicate([...rows, ...PaperBuilder.deduplicate(page)]), [])],
    ] as Array<[string, Paper[]]>) {
      const where = `journal article first, ${last} last, ${flow}`;
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi, journalDoi, where);
      assert.equal(rows[0].peerReviewed, true, where);
      assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], where);
    }
  }
});

test('a record\'s own `false` under the row\'s DOI stands against a merged row\'s confirmation of it', () => {
  // Synthetic records through the real mappers. OpenAlex files the eprint
  // among the locations of the journal article and of the paper's SSRN
  // entry. NASA ADS can list the article without the refereed property, and
  // Crossref can type it `other`.
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivId = '2601.00007';
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const arxivLocation = {
    landing_page_url: `https://arxiv.org/abs/${arxivId}`,
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
  const work = (id: string, doi: string, type: string, source: OpenAlexLocation['source'], isPublished = true): OpenAlexWork => {
    const location = { landing_page_url: `https://doi.org/${doi}`, is_published: isPublished, source };
    return {
      id: `https://openalex.org/${id}`,
      doi: `https://doi.org/${doi}`,
      title,
      type,
      authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
      publication_year: 2026,
      primary_location: location,
      locations: [location, arxivLocation],
    };
  };
  const article = work('W502', journalDoi, 'article', {
    id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal', host_organization_name: 'Elsevier',
  });
  const ssrn = work('W513', '10.2139/ssrn.4400000', 'preprint', {
    id: 'https://openalex.org/S4210172589', display_name: 'SSRN Electronic Journal', type: 'repository', host_organization_name: 'RELX Group',
  }, false);
  // As `arxivService` maps an entry with a DOI and no journal reference.
  const arxivRecord = (doi = journalDoi) => PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    authors: [{ name: 'Ana Economist' }],
    doi,
    publicationType: 'article',
    publicationStatus: 'published',
  });
  const notRefereed = () => mapAdsPaper({
    bibcode: '2026JIntE.160j3900E',
    title: [title],
    author: ['Economist, Ana'],
    doi: [journalDoi],
    identifier: [`arXiv:${arxivId}`],
    property: ['ARTICLE', 'OPENACCESS'],
    doctype: 'article',
    pub: 'Journal of International Economics',
    pubdate: '2026-01-00',
    year: '2026',
    abstract: 'Bank capital.',
  })!;
  const typedOther = () => mapCrossrefInstitutionWork({
    DOI: journalDoi,
    title: [title],
    type: 'other',
    author: [{ given: 'Ana', family: 'Economist' }],
    'container-title': ['Journal of International Economics'],
    publisher: 'Elsevier',
  })!;
  const search = (record: OpenAlexWork) => new OpenAlexAdapter().mapToStandard(record)!;
  const explorer = (record: OpenAlexWork) => slimWorksPage({ results: [record] }).papers[0];
  const peerReviewedOnly = (rows: Paper[]) => filterAndSortEntityPapers(rows, { filters: { peerReviewed: true } });

  // The followed feed puts the author's arXiv record before a topic row that
  // began as the SSRN entry and joined the article and the record denying
  // review under the same DOI, in either order. In one list the denial is
  // the last word on that DOI, and the merged row reads the same.
  for (const [label, denier] of [['ADS, not refereed', notRefereed], ['Crossref, typed other', typedOther]] as const) {
    for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
      for (const [order, records] of [
        ['the article first', [map(article), denier()]],
        ['the denial first', [denier(), map(article)]],
      ] as Array<[string, Paper[]]>) {
        const where = `${label}, ${order} (${mapper})`;
        const topic = PaperBuilder.deduplicate([map(ssrn), ...records]);
        assert.equal(topic.length, 1, where);
        for (const [flow, rows] of [
          ['followed', PaperBuilder.deduplicate([arxivRecord(), ...topic])],
          ['one list', PaperBuilder.deduplicate([arxivRecord(), map(ssrn), ...records])],
        ] as Array<[string, Paper[]]>) {
          assert.equal(rows.length, 1, `${where}, ${flow}`);
          assert.equal(rows[0].doi, journalDoi, `${where}, ${flow}`);
          assert.equal(rows[0].peerReviewed, false, `${where}, ${flow}`);
          assert.equal(peerReviewedOnly(rows).length, 0, `${where}, ${flow}`);
        }
      }
    }
  }

  // OpenAlex can keep its record of the eprint typed `preprint` under arXiv's
  // DOI while listing the journal's copy, and that record reads `true`. With
  // NASA ADS's non-refereed record of the article, which lists the same
  // eprint, a row under arXiv's DOI reads `false` in one list. So does the
  // followed feed's OpenAlex record of the eprint before a topic row that
  // joined the two, and the feed's card for that eprint beside the ADS card
  // that OpenAlex enriched, by its arXiv id, with the same record.
  const eprint = (id: string, locations: OpenAlexLocation[]): OpenAlexWork => ({
    ...article,
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/10.48550/arXiv.${arxivId}`,
    type: 'preprint',
    primary_location: arxivLocation,
    locations,
  });
  const eprintOnly = eprint('W501', [arxivLocation]);
  const eprintWithArticle = eprint('W503', [arxivLocation, article.primary_location!]);
  for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
    for (const [flow, rows] of [
      ['one list', PaperBuilder.deduplicate([map(eprintOnly), notRefereed(), map(eprintWithArticle)])],
      ['followed', PaperBuilder.deduplicate([map(eprintOnly), ...PaperBuilder.deduplicate([notRefereed(), map(eprintWithArticle)])])],
      ['enriched card', PaperBuilder.deduplicate([
        map(eprintWithArticle), PaperBuilder.merge(notRefereed(), mapOpenAlexEnrichmentWork(eprintWithArticle)!.enrichment, 'openalex'),
      ])],
    ] as Array<[string, Paper[]]>) {
      const where = `the eprint under arXiv's DOI beside ADS's non-refereed article, ${flow} (${mapper})`;
      assert.equal(rows.length, 1, where);
      assert.equal(rows[0].doi?.toLowerCase(), `10.48550/arxiv.${arxivId}`, where);
      assert.equal(rows[0].peerReviewed, false, where);
      assert.equal(peerReviewedOnly(rows).length, 0, where);
    }
  }

  // Semantic Scholar's record of the article names its venue and DOI but no
  // type, so `create` reads it as a preprint. That `false` is a gap, not a
  // denial: Crossref's record of the article stays reviewed before a
  // followed row that put an arXiv record listing the SSRN DOI before a
  // topic row that began as Semantic Scholar's record.
  const crossrefArticle = () => mapCrossrefInstitutionWork({
    DOI: journalDoi,
    title: [title],
    type: 'journal-article',
    author: [{ given: 'Ana', family: 'Economist' }],
    'container-title': ['Journal of International Economics'],
    publisher: 'Elsevier',
  })!;
  const semanticScholarArticle = () => new SemanticScholarAdapter().mapToStandard({
    paperId: 'e'.repeat(40),
    title,
    authors: [{ name: 'Ana Economist', authorId: '1' }],
    venue: 'Journal of International Economics',
    year: 2026,
    externalIds: { DOI: journalDoi, ArXiv: arxivId },
  });
  for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
    const where = `Crossref's article before a followed row holding Semantic Scholar's untyped record (${mapper})`;
    const rows = PaperBuilder.deduplicate([crossrefArticle(), ...PaperBuilder.deduplicate([
      arxivRecord('10.2139/ssrn.4400000'), ...PaperBuilder.deduplicate([semanticScholarArticle(), map(ssrn)]),
    ])]);
    assert.equal(rows.length, 1, where);
    assert.equal(rows[0].doi, journalDoi, where);
    assert.equal(rows[0].peerReviewed, true, where);
    assert.deepEqual(peerReviewedOnly(rows).map(row => row.doi), [journalDoi], where);
  }

  // A denial the row takes from a merged record rests on that record, not
  // on an arXiv DOI the merged row rests on. The FEDS paper that joined an
  // arXiv record listing the SSRN DOI with Crossref's report under the FEDS
  // DOI reads `false`, and the author's arXiv record under the journal DOI
  // before it stays unknown, as it does in one list.
  const fedsDoi = '10.17016/FEDS.2026.007';
  const feds = work('W500', fedsDoi, 'article', {
    id: 'https://openalex.org/S4210212089',
    display_name: 'Finance and Economics Discussion Series',
    type: 'journal',
    host_organization_name: 'Board of Governors of the Federal Reserve System',
  });
  const crossrefReport = () => mapCrossrefInstitutionWork({
    DOI: fedsDoi,
    title: [title],
    type: 'report',
    author: [{ given: 'Ana', family: 'Economist' }],
    'container-title': ['Finance and Economics Discussion Series'],
    publisher: 'Federal Reserve Board',
  })!;
  for (const [mapper, map] of [['search', search], ['Explorer', explorer]] as const) {
    const where = `an arXiv record under the journal DOI before the FEDS paper's row (${mapper})`;
    const workingPaper = PaperBuilder.deduplicate([
      map(feds), ...PaperBuilder.deduplicate([arxivRecord('10.2139/ssrn.4400000'), crossrefReport()]),
    ]);
    assert.equal(workingPaper.length, 1, where);
    assert.equal(workingPaper[0].peerReviewed, false, where);
    for (const [flow, rows] of [
      ['followed', PaperBuilder.deduplicate([arxivRecord(), ...workingPaper])],
      ['one list', PaperBuilder.deduplicate([arxivRecord(), map(feds), arxivRecord('10.2139/ssrn.4400000'), crossrefReport()])],
    ] as Array<[string, Paper[]]>) {
      assert.equal(rows.length, 1, `${where}, ${flow}`);
      assert.equal(rows[0].doi, journalDoi, `${where}, ${flow}`);
      assert.equal(rows[0].peerReviewed, undefined, `${where}, ${flow}`);
      assert.equal(peerReviewedOnly(rows).length, 0, `${where}, ${flow}`);
    }
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

// ENG-109: a card credits the source of an abstract recovered from Crossref or
// Semantic Scholar. The credit travels with the text whichever record of the
// paper a merge starts from: a journal article without an abstract taking its
// working paper's row (ENG-133), or the search palette's copy of a feed card
// beside a provider's record of the same paper.
test('an abstract recovered from another source keeps its credit, whichever record a merge starts from', () => {
  const text = 'The abstract Semantic Scholar holds for this paper, in full.';
  const recovered = PaperBuilder.merge(PaperBuilder.create({ id: 'openalex:W1', doi: '10.5555/credited', sources: { primary: 'openalex', enrichedBy: [] } }), { abstract: text, abstractSource: 'semanticscholar' }, 'semanticscholar');
  const article = PaperBuilder.create({ id: 'openalex:W2', doi: '10.5555/credited', sources: { primary: 'openalex', enrichedBy: [] } });
  const taken = PaperBuilder.merge(article, recovered, 'openalex');
  assert.deepEqual([taken.abstract, taken.abstractSource], [text, 'semanticscholar']);
  assert.ok(taken.sources.enrichedBy.includes('semanticscholar'), 'the credited source is among the sources merged in');
  for (const records of [[recovered, article], [article, recovered]]) {
    assert.equal(PaperBuilder.deduplicate(records)[0].abstractSource, 'semanticscholar', records[0].id);
  }
  // A paper with an abstract of its own keeps it, crediting no other source.
  const own = PaperBuilder.merge(PaperBuilder.create({ id: 'openalex:W3', abstract: 'The text OpenAlex lists for this paper itself.' }), recovered, 'openalex');
  assert.deepEqual([own.abstract, own.abstractSource], ['The text OpenAlex lists for this paper itself.', undefined]);
  // A credit the base holds without a usable text does not pass to the text
  // another record brings.
  const placeholder = { ...article, abstractSource: 'semanticscholar' as const };
  const arxiv = PaperBuilder.merge(placeholder, { abstract: 'The abstract arXiv lists for this paper.' }, 'arxiv');
  assert.deepEqual([arxiv.abstract, 'abstractSource' in arxiv], ['The abstract arXiv lists for this paper.', false]);
  assert.equal(PaperBuilder.merge(placeholder, { abstract: 'The abstract Crossref holds.', abstractSource: 'crossref' }, 'crossref').abstractSource, 'crossref');
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
