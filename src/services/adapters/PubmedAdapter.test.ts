import test from 'node:test';
import assert from 'node:assert/strict';
import { PubmedAdapter } from './PubmedAdapter.ts';
import { pubmedCategoryQuery } from './pubmedRecords.ts';
import { isFeedPublication } from '../feedPublicationRules.ts';
import { PaperBuilder } from '../PaperBuilder.ts';
import { accessTagForPaper, reviewStatusForPaper } from '../../utils/paperStatus.ts';

const adapter = new PubmedAdapter();

test('a Journal Article from esummary is typed as an article with unknown citations', () => {
  // esummary carries `pubtype` and no citation data at all. The adapter read
  // neither: it hard-coded `citationsCount: 0` — which `PaperBuilder` reads as a
  // CONFIRMED zero — and left the type empty, which the builder defaulted to
  // `preprint`. Every peer-reviewed article in the feed arrived as a preprint
  // with zero citations.
  const paper = PaperBuilder.create(adapter.mapToStandard({
    uid: '1', title: 'T', pubtype: ['Journal Article'], pubdate: '2024 Jan', source: 'J',
  }));

  assert.equal(paper.publicationType, 'article');
  assert.equal(paper.citationCountKnown, false);
  assert.equal(reviewStatusForPaper(paper), 'verified');
});

test('a PubMed preprint stays a preprint', () => {
  assert.equal(adapter.mapToStandard({ uid: '2', title: 'T', pubtype: ['Preprint'] }).publicationType, 'preprint');
});

test('a pubtype nobody recognises leaves the type unknown rather than guessing preprint', () => {
  const raw = adapter.mapToStandard({ uid: '3', title: 'T', pubtype: ['Historical Article'], source: 'J' });
  assert.equal(raw.publicationType, undefined);
  assert.equal(PaperBuilder.create(raw).publicationType, undefined);
});

test('arXiv keeps the preprint default the builder used to hand everyone', () => {
  // arXiv is the one source whose silence really does mean preprint.
  const paper = PaperBuilder.create({ id: 'arxiv:1', sources: { primary: 'arxiv', enrichedBy: [] } });
  assert.equal(paper.publicationType, 'preprint');
});

// On 2026-10-21 the labels searched in title and abstract (`[tiab]`) returned
// mostly reviews and papers that only name the discipline, and page 0 fell
// below main for molecular biology and neuroscience. In every field the labels
// also match Methods in Molecular Biology, whose chapters arrive a volume at a
// time and are dropped from the feed, so they would empty the lane; the query
// leaves the series out by ISSN. Records dated after today stay out as well.
test('the feed query searches each label in every field, without the protocol series, up to today', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T15:00:00Z') });

  assert.equal(
    pubmedCategoryQuery(['bio.gen', 'bio.mol', 'med.psych']),
    '("Genetics" OR "Molecular Biology" OR "Psychiatry & Mental Health") AND 1800/01/01:2026/10/20[dp] NOT ("1064-3745"[is] OR "1940-6029"[is])',
  );
});

// Synthetic esummary records, with the field names NCBI returned on
// 2026-10-20 and the series identifiers of the Europe PMC record captured that
// day (PMID 42879010). The titles are made up. Each names molecular biology,
// the evidence a search for bio.mol needs to keep a record in the lane.
function feedSearch(query: string, records: Array<Record<string, unknown>>) {
  return new PubmedAdapter({
    apiBase: 'https://papertok-report-api.example',
    fetchImpl: async () => Response.json({
      esearchresult: { count: String(records.length), idlist: records.map(record => record.uid) },
      result: Object.fromEntries(records.map(record => [record.uid, record])),
      efetch: '',
    }),
  }).search(query, 1, { internalCategories: ['bio.mol'], requireAbstract: true });
}

const CHAPTER = {
  uid: '42879010',
  title: 'A molecular biology protocol for Ewing sarcoma.',
  source: 'Methods Mol Biol',
  fulljournalname: 'Methods in molecular biology (Clifton, N.J.)',
  issn: '1064-3745',
  essn: '1940-6029',
  nlmuniqueid: '9214969',
  pubdate: '2027',
  pubtype: ['Journal Article'],
};

test('a Methods in Molecular Biology chapter is typed as a book-series chapter, which the feed leaves out', async () => {
  const { papers } = await feedSearch('chapter types', [
    CHAPTER,
    { ...CHAPTER, uid: '42879011', issn: '', essn: '', nlmuniqueid: '9214969' },
    { ...CHAPTER, uid: '42879012', issn: '', essn: '1940-6029', nlmuniqueid: '' },
    { uid: '42800001', title: 'A Nature article in molecular biology', source: 'Nature', issn: '0028-0836', essn: '1476-4687', nlmuniqueid: '0410462', pubdate: '2026 Oct 15', pubtype: ['Journal Article'] },
  ]);
  const shown = PaperBuilder.deduplicate(papers);

  assert.equal(shown[0].publicationType, 'book-chapter');
  assert.deepEqual(shown.filter(isFeedPublication).map(paper => paper.id), ['pmid:42800001']);
  assert.equal(shown[3].publicationType, 'article');
});

test('a PubMed record dated after today shows no year and no date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T15:00:00Z') });
  const { papers } = await feedSearch('chapter dates', [
    CHAPTER,
    { ...CHAPTER, uid: '2', pubdate: '2026 Nov' },
    { ...CHAPTER, uid: '3', pubdate: '2026 Oct' },
    { ...CHAPTER, uid: '4', pubdate: '2026 Oct 20' },
  ]);
  const [nextYear, nextMonth, thisMonth, today] = PaperBuilder.deduplicate(papers);

  for (const paper of [nextYear, nextMonth]) {
    assert.equal(paper.year, undefined, `${paper.id} is not given this year or next`);
    assert.equal(paper.published, '');
  }
  assert.equal(thisMonth.year, 2026);
  assert.equal(thisMonth.published, '2026 Oct');
  assert.equal(today.year, 2026);
});

// A print date with only a year or a month reads as the first day of that
// period: an article online on 16 October in the 2026 volume was dated
// 1 January, outside the corpus's 90 days, and the harvest dropped it.
// An online day after the issue's period is a late upload, which keeps the
// issue's date, as PMID 42900849 does below. Synthetic records in esummary's
// date forms.
test('a PubMed article whose issue names only a year or a month shows the day it went online within that period', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T15:00:00Z') });
  const { papers } = await feedSearch('partial dates', [
    { uid: '1', title: 'Molecular biology in a yearly volume', source: 'J', pubdate: '2026', epubdate: '2026 Oct 16', pubtype: ['Journal Article'] },
    { uid: '2', title: 'Molecular biology in a monthly issue', source: 'J', pubdate: '2026 Oct', epubdate: '2026 Oct 16', pubtype: ['Journal Article'] },
    { uid: '3', title: 'Molecular biology online the year before its volume', source: 'J', pubdate: '2026', epubdate: '2025 Dec 30', pubtype: ['Journal Article'] },
    { uid: '4', title: 'Molecular biology online after its monthly issue', source: 'J', pubdate: '2026 Jan', epubdate: '2026 Mar 3', pubtype: ['Journal Article'] },
    { uid: '5', title: 'Molecular biology in a two-month issue', source: 'J', pubdate: '2026 Sep-Oct', epubdate: '2026 Oct 16', pubtype: ['Journal Article'] },
  ]);

  assert.deepEqual(PaperBuilder.deduplicate(papers).map(paper => [paper.id, paper.year, paper.published]), [
    ['pmid:1', 2026, '2026 Oct 16'],
    ['pmid:2', 2026, '2026 Oct 16'],
    ['pmid:3', 2026, '2026'],
    ['pmid:4', 2026, '2026 Jan'],
    ['pmid:5', 2026, '2026 Oct 16'],
  ]);
});

// Dates as esummary gave them on 2026-10-20: PMID 42900737 (PNAS) went online
// that day in an issue printed on 27 October; PMID 42900849 (Biol Bull) went
// online after its issue was printed. The third record is not online yet.
test('a PubMed article online by today shows its online date when its issue is printed later', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T15:00:00Z') });
  const { papers } = await feedSearch('online dates', [
    { uid: '42900737', title: 'Molecular biology online before its issue', source: 'Proc Natl Acad Sci U S A', pubdate: '2026 Oct 27', epubdate: '2026 Oct 20', pubtype: ['Journal Article'] },
    { uid: '42900849', title: 'Molecular biology online after its issue', source: 'Biol Bull', pubdate: '2025 Oct', epubdate: '2026 Sep 24', pubtype: ['Journal Article'] },
    { uid: '3', title: 'Molecular biology not online yet', source: 'Neurology', pubdate: '2026 Dec', epubdate: '2026 Nov 2', pubtype: ['Journal Article'] },
  ]);

  assert.deepEqual(PaperBuilder.deduplicate(papers).map(paper => [paper.id, paper.year, paper.published]), [
    ['pmid:42900737', 2026, '2026 Oct 20'],
    ['pmid:42900849', 2025, '2025 Oct'],
    ['pmid:3', undefined, ''],
  ]);
});

// PAP-92. Nothing in esummary says a paper is closed, only that a PMC copy
// exists. The builder made every other record open (`openAccess: true` when
// unset), and the feed builds every lane through `deduplicate`, so each
// PubMed card without a PMC copy said "Open access" until OpenAlex answered.
// The same `true` kept the card from asking for a free copy.
function pubmedRecord(articleids: Array<{ idtype: string; value: string }> = []) {
  return adapter.mapToStandard({
    uid: '42900001',
    title: 'A synthetic trial',
    pubtype: ['Journal Article'],
    source: 'J',
    articleids: [{ idtype: 'doi', value: '10.5555/pap92' }, ...articleids],
  });
}
test('a PubMed record without a PMC copy keeps its access unknown, and shows no access chip', () => {
  for (const paper of [PaperBuilder.create(pubmedRecord()), PaperBuilder.deduplicate([pubmedRecord()])[0]]) {
    assert.equal(paper.openAccess, undefined);
    assert.equal(accessTagForPaper(paper), null);
  }
  const [deposited] = PaperBuilder.deduplicate([pubmedRecord([{ idtype: 'pmc', value: 'PMC1' }])]);
  assert.equal(accessTagForPaper(deposited)?.label, 'Open access', 'a PMC copy is still proof of access');
});
