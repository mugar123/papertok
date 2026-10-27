import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import {
  abstractsInFlight,
  getOpenAlexEnrichmentId,
  joinNotablePage,
  mergeFeedAbstracts,
  mergeOpenAlexEnrichment,
  needsOpenAlexEnrichment,
  notablePlaces,
  placeNotableCards,
  preserveFeedAbstracts,
  recoverableAbstractDois,
} from './feed-enrichment.ts';

test('normalizes arXiv versions for OpenAlex enrichment', () => {
  assert.equal(getOpenAlexEnrichmentId('arxiv:2607.12345v2'), '2607.12345');
  assert.equal(getOpenAlexEnrichmentId({ id: 'W123' }), 'openalex:W123');
  assert.equal(getOpenAlexEnrichmentId({ id: 'openalex:W123' }), 'openalex:W123');
  assert.equal(getOpenAlexEnrichmentId({ id: '', arxivId: '2607.54321v3' }), '2607.54321');
  assert.equal(getOpenAlexEnrichmentId({ id: '10.1000/example', arxivId: '2607.54321v3' }), '2607.54321');
});

test('does not request duplicate enrichment for native OpenAlex papers', () => {
  assert.equal(needsOpenAlexEnrichment({
    id: 'openalex:W123',
    sources: { primary: 'openalex', enrichedBy: [] as string[] },
  }), false);
  assert.equal(needsOpenAlexEnrichment({
    id: '2607.12345',
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  }), true);
  assert.equal(needsOpenAlexEnrichment({
    id: '2607.12345',
    sources: { primary: 'arxiv', enrichedBy: ['openalex'] },
  }), false);
  assert.equal(needsOpenAlexEnrichment({ id: 'pmid:12345' }), false);
});

type Card = { id: string; _notable?: boolean };

test("the fifteenth card of a new feed is the first notable card, and every other card stays in its order", () => {
  // The corpus's fifteen, the follows' and exploration's: 21 other cards.
  const others: Card[] = Array.from({ length: 21 }, (_, index) => ({ id: `card-${index}` }));
  const notable: Card[] = [{ id: 'notable-0', _notable: true }, { id: 'notable-1', _notable: true }];
  const page = placeNotableCards(others, notable, []);
  assert.equal(page.length, 22);
  assert.deepEqual(page.flatMap((paper, index) => (paper._notable ? [[index, paper.id]] : [])), [[14, 'notable-0']]);
  assert.deepEqual(page.filter(paper => !paper._notable), others, 'no other card is left out or moved past another');

  // With no notable card left, its place takes the next card; a notable card
  // never takes another place, even when the other cards run out first.
  assert.deepEqual(placeNotableCards(others, [], []), others);
  assert.deepEqual(placeNotableCards(others.slice(0, 3), notable, []).map(paper => paper.id), ['card-0', 'card-1', 'card-2']);
  // The place right after the last card: fourteen cards and a notable one fill fifteen.
  assert.equal(placeNotableCards(others.slice(0, 14), notable, []).at(-1)?.id, 'notable-0');
});

test('one card in fifteen is notable whatever size the pages are, when each page asks for its places', () => {
  // The feed's pages: the corpus's fifteen, up to six follows and up to ten
  // exploration cards, as STEP 5 adds them.
  for (const sizes of [[15], [21], [31], [15, 21, 31, 22], [7, 30, 16, 25]]) {
    const feed: Card[] = [];
    for (let page = 0; feed.length < 120; page += 1) {
      const size = sizes[page % sizes.length];
      // The corpus answers the places asked for a page of up to 31 cards.
      const asked = notablePlaces(feed, 31);
      const others: Card[] = Array.from({ length: size }, (_, index) => ({ id: `page${page}-${index}` }));
      const notable: Card[] = Array.from({ length: asked }, (_, index) => ({ id: `page${page}-notable-${index}`, _notable: true }));
      feed.push(...placeNotableCards(others, notable, feed));
    }
    const places = feed.flatMap((paper, index) => (paper._notable ? [index + 1] : []));
    assert.deepEqual(places, Array.from({ length: Math.floor(feed.length / 15) }, (_, index) => 15 * (index + 1)), `pages of ${sizes}`);
  }

  // A card dismissed before the notable one moved it up to fourteenth: the
  // next notable card is still fifteen cards after it, not the next one.
  const shown = Array.from({ length: 14 }, (_, index) => ({ id: `shown-${index}`, _notable: index === 13 }));
  const next = placeNotableCards<Card>(Array.from({ length: 20 }, (_, index) => ({ id: `next-${index}` })), [{ id: 'notable', _notable: true }], shown);
  assert.deepEqual(next.flatMap((paper, index) => (paper._notable ? [index] : [])), [14]);
});

// Related papers a like inserted, or a notable book that left, can leave
// seventeen other cards after the last notable card: its next place passed
// with no notable card. A page counted it as gone and placed its first one a
// place later, thirty cards after the last.
test('a notable place the feed has passed is the first card a page may still move', () => {
  const cards: Card[] = [
    ...Array.from({ length: 14 }, (_, index) => ({ id: `card-${index}` })),
    { id: 'notable-0', _notable: true },
    ...Array.from({ length: 17 }, (_, index) => ({ id: `after-${index}` })),
  ];
  const page: Card[] = Array.from({ length: 20 }, (_, index) => ({ id: `page-${index}` }));
  const notable: Card[] = [{ id: 'notable-1', _notable: true }, { id: 'notable-2', _notable: true }];
  const notableIndexes = (feed: Card[]) => feed.flatMap((paper, index) => (paper._notable ? [index] : []));

  // The reader is near the end: the place is behind the cards they reached,
  // so the first card after them takes it, three cards late.
  assert.deepEqual(notableIndexes([...cards, ...placeNotableCards(page, notable, cards)]), [14, 32, 47]);
  assert.deepEqual(notableIndexes(joinNotablePage(cards, page, notable, cards.length)), [14, 32, 47]);
  assert.equal(notablePlaces(cards, page.length, cards.length), 2);

  // The reader is on the eleventh card: the place is still ahead of them, and
  // the cards after the last notable one make room for the page's first.
  const joined = joinNotablePage(cards, page, notable, 10);
  assert.deepEqual(notableIndexes(joined), [14, 29, 44]);
  assert.deepEqual(joined.filter(paper => !paper._notable), [...cards.filter(paper => !paper._notable), ...page], 'every other card stays in its order');
  assert.equal(notablePlaces(cards, page.length, 10), 2);
});

test('merges OpenAlex metadata before a feed batch is displayed', () => {
  const papers = [{
    id: 'arxiv:2607.12345v1',
    title: 'Paper',
    citationCount: 0,
    citationCountKnown: false,
    concepts: [] as import('../models/paper.ts').PaperSubject[],
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  }];
  const merged = mergeOpenAlexEnrichment((papers as import('../models/paper.ts').Paper[]), {
    '2607.12345': {
      citationCount: 0,
      citationCountKnown: true,
      concepts: [{ id: 'C1', display_name: 'Cosmology' }],
    },
  });

  assert.equal(merged[0].citationCountKnown, true);
  assert.equal(merged[0].concepts![0].display_name, 'Cosmology');
  assert.deepEqual(merged[0].sources.enrichedBy, ['openalex']);
});

test('paper identity survives a late OpenAlex merge that adds nothing new', () => {
  // Three cases distinguish "no record for this paper" from "a record that
  // changes nothing": both must return the *same* object so memo(PaperCard)
  // and its IntersectionObserver (keyed on `paper`) are not torn down for a
  // card whose content never actually moved.
  const untouched = {
    id: 'arxiv:2607.11111',
    title: 'Untouched',
    citationCount: 0,
    citationCountKnown: false,
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  };
  const realChange = {
    id: 'arxiv:2607.22222',
    title: 'Real change',
    citationCount: 0,
    citationCountKnown: false,
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  };
  const noopChange = {
    id: 'arxiv:2607.33333',
    title: 'No-op change',
    citationCount: 12,
    citationCountKnown: true,
    sources: { primary: 'arxiv', enrichedBy: ['openalex'] },
    hasReferences: false,
    hasData: false,
    hasSupplement: false,
    peerReviewed: false,
    // PaperBuilder.merge unconditionally stamps `openAlex` with the raw
    // enrichment record it was given; this is a *different* object than the
    // one below (fresh API payload) but equal in every value, which is
    // exactly the case a reference check would miss.
    openAlex: { citationCount: 12, citationCountKnown: true },
  };

  const result = mergeOpenAlexEnrichment(([untouched, realChange, noopChange] as import('../models/paper.ts').Paper[]), {
    '2607.22222': { citationCount: 9, citationCountKnown: true },
    '2607.33333': { citationCount: 12, citationCountKnown: true },
  });

  assert.ok(Object.is(result[0], untouched), 'no record at all: same object');
  assert.ok(!Object.is(result[1], realChange), 'record with new data: different object');
  assert.equal(result[1].citationCount, 9);
  assert.ok(Object.is(result[2], noopChange), 'record present but changes nothing: same object');
});

test('a journal DOI is a way into OpenAlex when there is no arXiv id', () => {
  // Measured 2026-09-07: a paper whose arXiv landing page OpenAlex has not
  // indexed can still be there under the DOI its journal issued, and that
  // route was never tried.
  assert.equal(
    getOpenAlexEnrichmentId({ id: '2609.04966', arxivId: '2609.04966', doi: '10.1142/S0218271826500495' }),
    '2609.04966',
    'the arXiv id still wins: its landing-page filter found 5 of 5 where the DOI route missed one',
  );
  assert.equal(getOpenAlexEnrichmentId({ id: 'ads:2023ASPC', doi: '10.1142/S0218271826500495' }), 'doi:10.1142/s0218271826500495');
  assert.equal(getOpenAlexEnrichmentId({ id: 'ads:x', doi: 'https://doi.org/10.1023/A:1024156116636' }), 'doi:10.1023/a:1024156116636');
  assert.equal(
    getOpenAlexEnrichmentId({ id: 'pmid:1', doi: '10.48550/arxiv.2506.06595' }),
    '',
    'the arXiv pseudo-DOI is not a second route to the same work',
  );
  assert.equal(getOpenAlexEnrichmentId({ id: 'pmid:1', doi: 'not a doi' }), '');
});

test('a paper reachable only by its DOI is worth enriching', () => {
  assert.equal(needsOpenAlexEnrichment({
    id: 'ads:2023ASPC',
    doi: '10.1142/S0218271826500495',
    sources: { primary: 'nasa-ads', enrichedBy: [] as string[] },
  }), true);
  assert.equal(needsOpenAlexEnrichment({
    id: 'ads:2023ASPC',
    doi: '10.1142/S0218271826500495',
    sources: { primary: 'nasa-ads', enrichedBy: ['openalex'] },
  }), false);
});

test('late metadata keeps displayed abstract and summary stable without losing citation updates', () => {
  const current = [{ id: 'W2020715063', title: 'Effective action for strongly correlated electron systems', authors: [], abstract: '', summary: '', sources: { primary: 'openalex', enrichedBy: [] } }] as import('../models/paper.ts').Paper[];
  const enriched = [{ ...current[0], abstract: 'Late text', summary: 'Late text', citationCount: 16 }];
  const result = preserveFeedAbstracts(current, enriched);
  assert.equal(result[0].abstract, '');
  assert.equal(result[0].summary, '');
  assert.equal(result[0].citationCount, 16);
  assert.equal(preserveFeedAbstracts(current, [{ ...current[0], abstract: 'Late text' }])[0], current[0]);
});

test('late text fills only a card that says its abstract is loading', () => {
  const card = (id: string, abstract: string) => ({ id, title: `Synthetic paper ${id}`, authors: [], abstract, summary: abstract, sources: { primary: 'openalex', enrichedBy: [] } }) as Paper;
  const current = [card('loading', ''), card('settled', ''), card('shown', 'Publisher text.')];
  const enriched = current.map(paper => ({ ...paper, abstract: 'Late text', summary: 'Late text' }));
  const result = preserveFeedAbstracts(current, enriched, new Set(['loading', 'shown']));
  assert.deepEqual(result.map(paper => paper.abstract), ['Late text', '', 'Publisher text.']);
  assert.equal(result[0].summary, 'Late text');
});

test('a card is loading only while a request that can supply its abstract is running', () => {
  const papers = [
    { id: 'pubmed', pmid: '123', abstract: '', sources: { primary: 'pubmed', enrichedBy: [] } },
    { id: 'linked', arxivId: '1109.5103', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } },
    { id: 'physics-doi', doi: '10.1016/j.nuclphysb.2011.08.011', primaryCategory: 'hep-th', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } },
    { id: 'medicine-doi', doi: '10.5555/clinical-trial', primaryCategory: 'med.onc', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } },
    { id: 'with-text', pmid: '456', abstract: 'Publisher text.', sources: { primary: 'pubmed', enrichedBy: [] } },
  ].map(paper => ({ title: `Synthetic paper ${paper.id}`, authors: [], ...paper }));
  const all = { openAlex: true, europePmc: true, recovery: true };
  assert.deepEqual([...abstractsInFlight(papers, all)], ['pubmed', 'linked', 'physics-doi']);
  assert.deepEqual([...abstractsInFlight(papers, { ...all, recovery: false })], ['pubmed']);
  assert.deepEqual([...abstractsInFlight(papers, { openAlex: false, europePmc: false, recovery: false })], []);
});

test('the DOIs whose abstract a publisher record can supply: OpenAlex and PubMed papers without one, in any area, each once', () => {
  const papers = [
    { id: 'W1', doi: 'https://doi.org/10.5555/Clinical-Trial', primaryCategory: 'med.onc', abstract: 'No abstract available.' },
    { id: 'W2', doi: '10.1016/j.nuclphysb.2011.08.011', primaryCategory: 'hep-th', abstract: '' },
    { id: 'W3', doi: '10.5555/clinical-trial', abstract: '' },
    { id: 'W4', doi: '10.1000/with-text', abstract: 'Publisher text.' },
    { id: 'W5', abstract: '' },
    { id: 'pmid:9', doi: '10.1000/pubmed-record', abstract: '', primary: 'pubmed' },
    { id: 'arxiv:2601.00001', doi: '10.1000/arxiv-record', abstract: '', primary: 'arxiv' },
    { id: 'W6', doi: '10.1000/editorial', abstract: '', publicationType: 'editorial' },
  ].map(({ primary = 'openalex', ...paper }) => ({ title: `Synthetic paper ${paper.id}`, authors: [], ...paper, sources: { primary, enrichedBy: [] } }));
  assert.deepEqual(recoverableAbstractDois(papers), ['10.1000/pubmed-record', '10.1016/j.nuclphysb.2011.08.011', '10.5555/clinical-trial']);
});

test('recovered abstracts apply in the order arXiv, INSPIRE, Crossref, Semantic Scholar, and only to the paper they name', () => {
  const paper = { id: 'W7', arxivId: '2601.00001', doi: '10.1000/shared', title: 'Synthetic paper W7', authors: [], abstract: 'No abstract available.', sources: { primary: 'openalex', enrichedBy: [] } } as Paper;
  const record = (primary: string, abstract: string) => ({ arxivId: '2601.00001', doi: 'https://doi.org/10.1000/SHARED', abstract, sources: { primary, enrichedBy: [] } });
  const from = (source: string) => `The abstract ${source} holds for this paper, in full.`;
  const records = [record('semanticscholar', from('Semantic Scholar')), record('crossref', from('Crossref')), record('inspire', from('INSPIRE')), record('arxiv', from('arXiv'))];
  const merged = (kept: Partial<Paper>[]) => mergeFeedAbstracts([paper], kept)[0];
  assert.equal(merged(records).abstract, from('arXiv'));
  assert.deepEqual(merged(records).sources.enrichedBy, ['arxiv']);
  assert.equal(merged(records.slice(0, 3)).abstract, from('INSPIRE'));
  assert.equal(merged(records.slice(0, 2)).abstract, from('Crossref'));
  assert.deepEqual(merged(records.slice(0, 2)).sources.enrichedBy, ['crossref']);
  assert.equal(merged(records.slice(0, 1)).abstract, from('Semantic Scholar'));
  assert.deepEqual(merged(records.slice(0, 1)).sources.enrichedBy, ['semanticscholar']);
  // A placeholder is not a usable abstract, and a record for another DOI is not this paper's.
  assert.equal(merged([record('crossref', 'No abstract available.'), record('semanticscholar', from('Semantic Scholar'))]).abstract, from('Semantic Scholar'));
  const unrelated = [{ doi: '10.1000/other', abstract: from('another paper'), sources: { primary: 'crossref', enrichedBy: [] } }];
  assert.equal(mergeFeedAbstracts([{ ...paper, arxivId: undefined }], unrelated)[0].abstract, 'No abstract available.');
});

// ENG-109: a card credits Crossref or Semantic Scholar for an abstract it
// shows from them, so the paper names that source beside the text.
test('an abstract recovered from Crossref or Semantic Scholar names its source; one from arXiv or INSPIRE, a refused one and a kept one do not', () => {
  const paper = { id: 'W8', arxivId: '2601.00002', doi: '10.1000/credited', title: 'Synthetic paper W8', authors: [], abstract: 'No abstract available.', sources: { primary: 'openalex', enrichedBy: [] } } as Paper;
  const record = (primary: string, abstract: string) => ({ arxivId: '2601.00002', doi: '10.1000/credited', abstract, sources: { primary, enrichedBy: [] } });
  const text = 'The abstract this source holds for the paper, in full.';
  const recovered = (records: Partial<Paper>[], base = paper) => mergeFeedAbstracts([base], records)[0];
  assert.equal(recovered([record('semanticscholar', text)]).abstractSource, 'semanticscholar');
  assert.equal(recovered([record('crossref', text)]).abstractSource, 'crossref');
  assert.equal(recovered([record('arxiv', text)]).abstractSource, undefined);
  assert.equal(recovered([record('inspire', text)]).abstractSource, undefined);
  // Semantic Scholar's text past 6,000 characters is no abstract: the paper keeps none, and credits no one.
  const refused = recovered([record('semanticscholar', 'x'.repeat(6001))]);
  assert.deepEqual([refused.abstract, refused.abstractSource], ['No abstract available.', undefined]);
  // A paper with its own abstract keeps it, uncredited.
  const own = recovered([record('semanticscholar', text)], { ...paper, abstract: 'The text OpenAlex lists for this paper itself.' });
  assert.deepEqual([own.abstract, own.abstractSource], ['The text OpenAlex lists for this paper itself.', undefined]);
});
