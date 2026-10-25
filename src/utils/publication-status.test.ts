import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arxivCommentSaysPublished,
  openAlexIsWorkingPaper,
  openAlexPeerReviewed,
  openAlexPublicationStatus,
  semanticScholarIsPreprint,
} from './publication-status.ts';
import { arxivPaper } from '../services/arxiv-records.ts';
import { slimWorksPage } from '../services/open-alex-service.ts';
import { SemanticScholarAdapter } from '../services/adapters/semantic-scholar-adapter.ts';
import { mapOpenAlexEnrichmentWork, mapOpenAlexWork } from './open-alex-work.ts';

// Chapters and accepted papers labelled «Preprint» (audit 2026-09-23, issue
// 12a): of 31 recent chapters in the guest's six computing categories, 23
// carried the chip, and about 16 said in their own arXiv comment that they
// were accepted or published.

test('an arXiv comment that says the paper is accepted or out makes it published', () => {
  for (const comment of [
    // Measured: 2607.02734, 2608.12077, 2606.06074.
    'Accepted for publication as a book chapter (Taylor & Francis, 2026)',
    'To appear as a chapter in the book "Foundations of Robot Learning"',
    'Accepted at the 40th AAAI Conference on Artificial Intelligence',
    // The phrasings the rule already read.
    'Accepted in IEEE Transactions on Pattern Analysis and Machine Intelligence',
    'Published in Nature Physics 21, 1203 (2025)',
    'Appears in Proceedings of the 42nd International Conference on Machine Learning',
    'To appear in ICML 2026',
    // Same meaning, other prepositions.
    'Accepted to CVPR 2026. Code is available',
    'To appear at ICRA 2026',
  ]) {
    assert.equal(arxivCommentSaysPublished(comment), true, comment);
  }
});

test('an arXiv comment that only describes or submits the paper leaves it a preprint', () => {
  for (const comment of [
    'Submitted to NeurIPS 2026',
    'Under review at ICLR 2027',
    '12 pages, 5 figures',
    'Preprint. Work in progress',
    '',
    null,
  ]) {
    assert.equal(arxivCommentSaysPublished(comment), false, String(comment));
  }
});

test('an OpenAlex work is a preprint by its type, not by where its best copy sits', () => {
  // 8 in 100 random chapters had a repository as primary location, and were
  // labelled preprints for it.
  const repository = { is_published: false, source: { type: 'repository' } };
  assert.equal(openAlexPublicationStatus({ type: 'book-chapter', primary_location: repository }), 'published');
  assert.equal(openAlexPublicationStatus({ type: 'article', primary_location: repository }), 'published');
  assert.equal(openAlexPublicationStatus({ type: 'preprint', primary_location: repository }), 'preprint');
  assert.equal(openAlexPublicationStatus({ type: 'posted-content' }), 'preprint');
  assert.equal(openAlexPublicationStatus({ type: 'Book-Chapter' }), 'published');
});

test('a work typed as a preprint is published once any copy of it is the published one', () => {
  // The enrichment mapper's rule, which the card mappers now share: a later
  // journal version is evidence, and dropping it would label the paper wrongly
  // the other way.
  assert.equal(openAlexPublicationStatus({ type: 'preprint', primary_location: { is_published: true } }), 'published');
  assert.equal(
    openAlexPublicationStatus({ type: 'preprint', locations: [{ is_published: false }, { is_published: true }] }),
    'published',
  );
});

test('an OpenAlex work with no type falls back on whether any copy is published', () => {
  assert.equal(openAlexPublicationStatus({ primary_location: { is_published: true } }), 'published');
  assert.equal(openAlexPublicationStatus({ locations: [{ is_published: false }, { is_published: true }] }), 'published');
  assert.equal(openAlexPublicationStatus({ primary_location: { is_published: false } }), 'preprint');
  assert.equal(openAlexPublicationStatus(null), 'preprint');
});

// The primary locations OpenAlex returned on 2026-10-19, trimmed to what the
// rule reads. The series come back exactly as a Nature paper does: `article`,
// in a `journal`, published version. Only the source ID tells them apart.
const published = (display_name: string, type: string, id?: string) => ({
  is_published: true,
  source: { ...(id ? { id: `https://openalex.org/${id}` } : {}), display_name, type },
});
const IMF_WORKING_PAPER = { type: 'article', primary_location: published('IMF Working Paper', 'journal', 'S4210171147') };
const FEDS_PAPER = {
  type: 'article',
  primary_location: published('Finance and Economics Discussion Series', 'journal', 'S4210212089'),
};
const FRBSF_PAPER = {
  type: 'article',
  primary_location: published('Federal Reserve Bank of San Francisco, Working Paper Series', 'journal', 'S4306510381'),
};
const KANSAS_CITY_FED_PAPER = {
  type: 'article',
  primary_location: published('The Federal Reserve Bank of Kansas City Research Working Papers', 'journal', 'S4210173933'),
};
const FEDS_NOTE = { type: 'article', primary_location: published('FEDS Notes', 'journal', 'S4210225578') };
const NBER_PAPER = {
  type: 'report',
  primary_location: published('National Bureau of Economic Research', 'repository', 'S2809516038'),
};
const NATURE_PAPER = { type: 'article', primary_location: published('Nature', 'journal', 'S137773608') };

test('a working paper OpenAlex files as a journal article is not peer reviewed', () => {
  assert.equal(openAlexPeerReviewed(IMF_WORKING_PAPER), false);
  assert.equal(openAlexPeerReviewed(FEDS_PAPER), false);
  assert.equal(openAlexPeerReviewed(FRBSF_PAPER), false);
  assert.equal(openAlexPeerReviewed(KANSAS_CITY_FED_PAPER), false);
  // Nothing in the name says so.
  assert.equal(openAlexPeerReviewed(FEDS_NOTE), false);
  assert.equal(openAlexPeerReviewed(NBER_PAPER), false);
  // A copy in a journal elsewhere does not turn the series' paper into one.
  assert.equal(openAlexPeerReviewed({ ...IMF_WORKING_PAPER, locations: [published('Some Journal', 'journal')] }), false);
});

// Sources whose OpenAlex name does not say working paper, with the IDs and
// types OpenAlex gave on 2026-10-19. CESifo already holds one `article`,
// W7144132107, filed as a journal article in a journal.
test('an article in a listed working-paper series is not peer reviewed, whatever the series is called', () => {
  const inSeries = (id: string, name: string, type: string) => ({ type: 'article', primary_location: published(name, type, id) });
  assert.equal(openAlexPeerReviewed(inSeries('S7407053623', 'CESifo', 'journal')), false);
  assert.equal(openAlexPeerReviewed(inSeries('S4393919745', 'Staff reports', 'journal')), false);
  assert.equal(openAlexPeerReviewed(inSeries(
    'S4393913881', 'Documentos de trabajo/Documento de trabajo - Banco de España, Servicio de Estudios', 'journal',
  )), false);
  // NBER's source is a repository, which alone would leave the answer unknown.
  assert.equal(openAlexPeerReviewed(inSeries('S2809516038', 'National Bureau of Economic Research', 'repository')), false);
  // A copy in one of the series does not hide the journal that published it.
  assert.equal(openAlexPeerReviewed({
    ...NATURE_PAPER,
    locations: [published('CESifo', 'journal', 'S7407053623')],
  }), true);
});

test('a source named like a working-paper series, but not listed, leaves peer review unknown', () => {
  // A journal (PAGEPress) that a name rule would have called a working paper.
  const publicHealth = { type: 'article', primary_location: published('Working Paper of Public Health', 'journal', 'S4210222596') };
  assert.equal(openAlexPeerReviewed(publicHealth), undefined);
  assert.equal(openAlexIsWorkingPaper(publicHealth), false);
  // A synthetic unlisted series is not a venue either, so it is not called reviewed.
  const unlisted = { type: 'article', primary_location: published('Bank of Somewhere Working Paper Series', 'journal', 'S1') };
  assert.equal(openAlexPeerReviewed(unlisted), undefined);
  assert.equal(openAlexIsWorkingPaper(unlisted), false);
});

test('a report or a paper in a listed series is a working paper; a journal article is not', () => {
  for (const work of [IMF_WORKING_PAPER, FEDS_PAPER, FRBSF_PAPER, KANSAS_CITY_FED_PAPER, FEDS_NOTE, NBER_PAPER]) {
    assert.equal(openAlexIsWorkingPaper(work), true, work.primary_location.source.display_name);
  }
  assert.equal(openAlexIsWorkingPaper(NATURE_PAPER), false);
  // The primary location is the record's own venue; a copy in a series is not.
  assert.equal(openAlexIsWorkingPaper({ ...NATURE_PAPER, locations: [IMF_WORKING_PAPER.primary_location] }), false);
  assert.equal(openAlexIsWorkingPaper(null), false);
});

test('a paper in a journal or proceedings keeps the peer review its venue shows', () => {
  assert.equal(openAlexPeerReviewed(NATURE_PAPER), true);
  assert.equal(openAlexPeerReviewed({ type: 'review', primary_location: published('Nature Reviews Physics', 'journal') }), true);
  // U-Net (W1901129140): MICCAI, in Lecture Notes in Computer Science.
  assert.equal(openAlexPeerReviewed({
    type: 'conference-paper',
    primary_location: published('Lecture notes in computer science', 'book series'),
  }), true);
  // A preprint record whose journal version OpenAlex has found.
  assert.equal(openAlexPeerReviewed({
    type: 'preprint',
    primary_location: { is_published: false, source: { display_name: 'arXiv (Cornell University)', type: 'repository' } },
    locations: [published('Physical Review Letters', 'journal')],
  }), true);
});

test('a record that shows no venue leaves peer review unknown rather than false', () => {
  assert.equal(openAlexPeerReviewed({ type: 'article', primary_location: published('Zenodo', 'repository') }), undefined);
  assert.equal(openAlexPeerReviewed({ type: 'article', primary_location: { is_published: true, source: null } }), undefined);
  assert.equal(openAlexPeerReviewed({ type: 'article' }), undefined);
  assert.equal(openAlexPeerReviewed({ primary_location: published('Nature', 'journal') }), undefined);
  assert.equal(openAlexPeerReviewed({ type: 'editorial', primary_location: published('Nature', 'journal') }), undefined);
  assert.equal(openAlexPeerReviewed({ type: 'book-chapter', primary_location: published('Routledge eBooks', 'ebook platform') }), undefined);
  assert.equal(openAlexPeerReviewed(null), undefined);
});

test('a preprint with no published copy is not peer reviewed', () => {
  assert.equal(openAlexPeerReviewed({
    type: 'preprint',
    primary_location: { is_published: false, source: { display_name: 'arXiv (Cornell University)', type: 'repository' } },
  }), false);
});

test('a Semantic Scholar review is an article, not a preprint', () => {
  // PMID 30617335, a Nature Medicine review, carried the chip.
  assert.equal(semanticScholarIsPreprint(['Review', 'JournalArticle']), false);
  assert.equal(semanticScholarIsPreprint(['Review']), false);
  assert.equal(semanticScholarIsPreprint(['Preprint']), true);
  assert.equal(semanticScholarIsPreprint(['preprint']), true);
  assert.equal(semanticScholarIsPreprint(undefined), false);
});

// The mappers that build a card label it by these rules, so a chapter or an
// accepted paper is not a preprint on one surface and published on another.
test('the arXiv, OpenAlex and Semantic Scholar mappers label a paper by these rules', () => {
  const accepted = arxivPaper({
    arxivId: '2607.02734', title: 'T', abstract: 'A', authors: ['Ada Lovelace'], doi: '', journalRef: '',
    comment: 'Accepted at the 40th AAAI Conference on Artificial Intelligence',
    published: '2026-07-03', allCategories: ['cs.LG'], primaryCategory: 'cs.LG',
  });
  assert.equal(accepted.publicationStatus, 'published', 'arXiv: the comment says it is accepted');

  // A chapter whose best copy sits in a repository.
  const chapter = {
    id: 'https://openalex.org/W1',
    type: 'book-chapter',
    primary_location: { is_published: false, source: { type: 'repository' } },
  };
  assert.equal(slimWorksPage({ results: [chapter] }).papers[0].publicationStatus, 'published', 'OpenAlex search and explorer');
  assert.equal(mapOpenAlexWork(chapter)?.publicationStatus, 'published', 'OpenAlex lanes');
  assert.equal(mapOpenAlexEnrichmentWork(chapter)?.enrichment.publicationStatus, 'published', 'OpenAlex enrichment');

  const review = new SemanticScholarAdapter().mapToStandard({ paperId: 'abc', publicationTypes: ['Review'] });
  assert.equal(review.publicationStatus, 'published', 'Semantic Scholar: a review is not a preprint');
});
