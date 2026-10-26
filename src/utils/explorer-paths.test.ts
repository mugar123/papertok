import test from 'node:test';
import assert from 'node:assert/strict';
import { authorExplorerPath, journalExplorerLink, openAlexAuthorId } from './explorer-paths.ts';
import { mapOpenAlexWork } from './open-alex-work.ts';
import { PaperBuilder } from '../services/paper-builder.ts';

// ENG-123: a journal is followed from its page in the Explorer, and the
// reader opens that page from the journal's name. Works shaped as OpenAlex
// returns them; American Economic Review is S23254222 (`/sources/issn:0002-8282`,
// 2026-10-25) and arXiv's repository S4306400194.
const aerWork = (source: { id?: string; display_name?: string; type: string }) => mapOpenAlexWork({
  id: 'https://openalex.org/W7000000001',
  title: 'Monetary policy and the term structure',
  type: 'article',
  publication_date: '2026-10-01',
  primary_location: { is_published: true, source },
});

test("the reader links a paper's journal to the journal's Explorer page, by its OpenAlex id", () => {
  const listed = aerWork({ id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' })!;
  // The corpus files a listing as `PaperBuilder.create` builds it.
  const corpusPaper = PaperBuilder.create(listed);
  const americanEconomicReview = { name: 'American Economic Review', path: '/explorer/source/S23254222' };
  assert.deepEqual(journalExplorerLink(listed), americanEconomicReview, 'an OpenAlex lane or Explorer page');
  assert.deepEqual(journalExplorerLink(corpusPaper), americanEconomicReview, 'a paper the corpus serves');
  const preprint = PaperBuilder.create({
    id: '2610.11111', arxivId: '2610.11111', sources: { primary: 'arxiv', enrichedBy: [] },
    title: 'Monetary policy and the term structure', journal: 'Am. Econ. Rev. 116, 1 (2026)',
  });
  assert.deepEqual(journalExplorerLink(PaperBuilder.merge(preprint, listed, 'openalex')), americanEconomicReview, 'a preprint OpenAlex lists as the article');
  assert.deepEqual(journalExplorerLink({ ...corpusPaper, journal: 'Am Econ Rev' }), americanEconomicReview, "OpenAlex's name before another provider's");
  assert.deepEqual(journalExplorerLink({ id: 'openalex:W7000000001', journal: 'American Economic Review', venueId: 'S23254222' }), americanEconomicReview, 'an OpenAlex search result');
  // An arXiv paper OpenAlex enriched keeps arXiv's journal reference as its
  // journal; the page, opened by id, shows the source's own name. (A
  // synthetic source id.)
  assert.deepEqual(
    journalExplorerLink({ id: '2301.00001', journal: 'Phys. Rev. Lett. 130, 041801 (2023)', venueId: 'S9000000001' }),
    { name: 'Phys. Rev. Lett. 130, 041801 (2023)', path: '/explorer/source/S9000000001' },
  );
});

test('a paper gets no journal link without a journal OpenAlex identifies, or without its name', () => {
  assert.equal(journalExplorerLink({ id: '2401.12345', journal: 'Phys. Rev. Lett. 130, 041801 (2023)' }), null, "arXiv's journal reference names no OpenAlex source");
  assert.equal(journalExplorerLink(aerWork({ id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' })), null, 'a repository is no journal');
  assert.equal(journalExplorerLink(aerWork({ id: 'https://openalex.org/S23254222', type: 'journal' })), null, 'a journal OpenAlex gives no name');
  assert.equal(journalExplorerLink(null), null);
  // Semantic Scholar names its venue in `sourceName`, and no id comes with it:
  // the row keeps neither, and lends that name to no OpenAlex journal.
  const semanticScholar = { id: 's2:1', sources: { primary: 'semanticscholar', enrichedBy: [] }, title: 'Monetary policy', sourceName: 'AER' };
  assert.equal(PaperBuilder.create(semanticScholar).sourceName, undefined);
  const article = { ...PaperBuilder.create({ id: 'openalex:W7000000001', sources: { primary: 'openalex', enrichedBy: [] }, title: 'Monetary policy' }), journal: 'American Economic Review', venueId: 'S23254222' };
  assert.equal(PaperBuilder.merge(article, semanticScholar, 'semanticscholar').sourceName, undefined);
});

test('an author with an OpenAlex id opens by id, name riding along for the masthead', () => {
  assert.equal(
    authorExplorerPath({ name: 'Ada Lovelace', id: 'https://openalex.org/A5023888391' }, 'openalex:W1'),
    '/explorer/author/A5023888391?name=Ada%20Lovelace',
  );
  assert.equal(authorExplorerPath({ name: 'Ada', id: 'a5023888391' }, 'x'), '/explorer/author/A5023888391?name=Ada', 'a bare id, any case');
  assert.equal(openAlexAuthorId({ id: 'https://openalex.org/I123' }), '', 'an institution id is not an author');
});

test('an author without an id keeps the name door, with the arXiv id the explorer matches on', () => {
  assert.equal(authorExplorerPath({ name: 'Grace Hopper' }, 'arxiv:2401.12345'), '/explorer/author/Grace%20Hopper?arxivId=2401.12345');
  assert.equal(authorExplorerPath('Grace Hopper', '2401.12345'), '/explorer/author/Grace%20Hopper?arxivId=2401.12345', 'a plain string author');
  assert.equal(authorExplorerPath({ name: '' }, 'x'), '', 'nothing to open');
});

test('signed out, the public entity page gets the id when there is one, and the name beside it', () => {
  assert.equal(
    authorExplorerPath({ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }, 'x', { publicMode: true }),
    '/public/entity/author/A1?name=Ada%20Lovelace',
  );
  assert.equal(authorExplorerPath({ name: 'Ada Lovelace' }, 'x', { publicMode: true }), '/public/entity/author/Ada%20Lovelace');
});

// PubMed and Europe PMC authors arrive without an OpenAlex id, and the card
// used to hand the paper's `pmid:…` id over as an "arXiv id" the explorer
// turned into an impossible `10.48550/arxiv.pmid:…` DOI; the name search it
// fell back to picked "Po-Wn Li" for "Li WN" (audit 2026-09-23, issue 4).
// An ORCID is a person OpenAlex may not have linked to any author entity yet,
// so the paper travels with it: without it, an unlinked ORCID fell back to an
// arXiv search by the ORCID's name and showed homonyms' papers as the
// person's (review of 2026-09-25).
test('an author with an ORCID and no OpenAlex id opens by ORCID, with the paper beside it', () => {
  assert.equal(
    authorExplorerPath({ name: 'Li WN', orcid: 'https://orcid.org/0000-0002-1825-0097' }, { id: 'pmid:42774036', pmid: '42774036' }),
    '/explorer/author/0000-0002-1825-0097?name=Li%20WN&paper=pmid%3A42774036',
  );
  assert.equal(
    authorExplorerPath({ name: 'Li WN', orcid: '0000-0002-1825-009X' }, {}, { publicMode: true }),
    '/public/entity/author/0000-0002-1825-009X?name=Li%20WN',
  );
});

test('a name-only author carries the paper it was clicked from, by its most reliable id', () => {
  const editorial = { id: 'pmid:42774036', pmid: '42774036', doi: '10.3389/fendo.2026.1980821' };
  assert.equal(
    authorExplorerPath({ name: 'Li WN' }, editorial),
    '/explorer/author/Li%20WN?paper=doi%3A10.3389%2Ffendo.2026.1980821',
  );
  assert.equal(
    authorExplorerPath({ name: 'Li WN' }, { id: 'pmid:42774036', pmid: '42774036' }),
    '/explorer/author/Li%20WN?paper=pmid%3A42774036',
  );
  assert.equal(
    authorExplorerPath({ name: 'Grace Hopper' }, { id: '2401.12345', arxivId: '2401.12345' }),
    '/explorer/author/Grace%20Hopper?arxivId=2401.12345',
  );
  assert.equal(authorExplorerPath({ name: 'Li WN' }, 'pmid:42774036'), '/explorer/author/Li%20WN?paper=pmid%3A42774036');
  assert.equal(authorExplorerPath({ name: 'Nobody' }, { id: 'europepmc:PPR:1' }), '/explorer/author/Nobody');
});

test('signed out, the name-only door keeps the paper too', () => {
  assert.equal(
    authorExplorerPath({ name: 'Li WN' }, { id: 'pmid:42774036', pmid: '42774036' }, { publicMode: true }),
    '/public/entity/author/Li%20WN?paper=pmid%3A42774036',
  );
});
