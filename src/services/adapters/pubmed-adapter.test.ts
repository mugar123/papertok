import type { OpenAlexWork } from './open-alex-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PubmedAdapter } from './pubmed-adapter.ts';
import { pubmedCategoryQuery } from './pubmed-records.ts';
import { isFeedPublication, isFeedPublicationType } from '../feed-publication-rules.ts';
import { PaperBuilder } from '../paper-builder.ts';
import { accessTagForPaper, reviewStatusForPaper } from '../../utils/paper-status.ts';
import { mapOpenAlexEnrichmentWork, mapOpenAlexWork } from '../../utils/open-alex-work.ts';

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

test("PubMed's errata, retraction notices, expressions of concern and front matter leave the feed, a letter does not", () => {
  const typeOf = (pubtype: string[]) => PaperBuilder.create(adapter.mapToStandard({ uid: '4', title: 'T', pubtype, source: 'J' }));
  for (const pubtype of [
    ['Published Erratum'], ['Journal Article', 'Published Erratum'],
    ['Retraction of Publication'], ['Journal Article', 'Expression of Concern'],
    ['News'], ['Obituary', 'Journal Article'], ['Biography', 'Historical Article', 'Portrait'], ['Interview'], ['Introductory Journal Article'],
  ]) {
    assert.equal(isFeedPublication(typeOf(pubtype)), false, pubtype.join(', '));
  }
  // The retracted article itself is a research record.
  assert.equal(typeOf(['Journal Article', 'Retracted Publication']).publicationType, 'article');
  assert.equal(typeOf(['Letter', 'Comment']).publicationType, 'letter');
  assert.equal(isFeedPublication(typeOf(['Letter', 'Comment'])), true);
});

// Captured from esummary on 2026-10-27 (keyless) and trimmed: Wakefield et al.,
// Lancet 1998, which PubMed types `Retracted Publication`, and a journal
// article of September 2026 with no other type.
const WAKEFIELD_SUMMARY = {
  uid: '9500320',
  pubdate: '1998 Feb 28',
  epubdate: '',
  source: 'Lancet',
  authors: [{ name: 'Wakefield AJ' }, { name: 'Murch SH' }],
  title: 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children.',
  nlmuniqueid: '2985213R',
  issn: '0140-6736',
  essn: '',
  pubtype: ['Journal Article', "Research Support, Non-U.S. Gov't", 'Retracted Publication'],
  articleids: [{ idtype: 'pubmed', value: '9500320' }, { idtype: 'doi', value: '10.1016/s0140-6736(97)11096-0' }],
};
const ARTICLE_SUMMARY = {
  uid: '42934083',
  pubdate: '2026 Sep 30',
  epubdate: '2026 Sep 30',
  source: 'J Pediatr Urol',
  authors: [{ name: 'Manivasagam SS' }, { name: 'Kane JA' }, { name: 'Decter RM' }],
  title: 'Current trends in opioid prescription at discharge after pediatric urologic procedures: Analysis of ACS NSQIP pediatrics 2023 database.',
  nlmuniqueid: '101233150',
  issn: '1477-5131',
  essn: '1873-4898',
  pubtype: ['Journal Article'],
  articleids: [{ idtype: 'pubmed', value: '42934083' }, { idtype: 'doi', value: '10.1016/j.jpurol.2026.106308' }],
};

test('an article PubMed types `Retracted Publication` is retracted, which the feed leaves out, and an article without the type is not', () => {
  const retracted = PaperBuilder.create(adapter.mapToStandard(WAKEFIELD_SUMMARY));
  assert.deepEqual([retracted.publicationType, retracted.publicationStatus], ['article', 'retracted']);
  assert.equal(isFeedPublication(retracted), false);
  assert.equal(isFeedPublicationType(retracted), true, 'left out as retracted, not for its type');

  const article = PaperBuilder.create(adapter.mapToStandard(ARTICLE_SUMMARY));
  assert.deepEqual([article.publicationType, article.publicationStatus], ['article', 'published']);
  assert.equal(isFeedPublication(article), true);

  // The type padded or in another case is the same type.
  for (const type of ['Retracted Publication ', ' retracted publication']) {
    const padded = PaperBuilder.create(adapter.mapToStandard({ ...WAKEFIELD_SUMMARY, pubtype: ['Journal Article', type] }));
    assert.equal(padded.publicationStatus, 'retracted', JSON.stringify(type));
  }
});

// Captured from OpenAlex on 2026-10-26 (W2117847125) and trimmed, with
// `is_retracted` cleared: OpenAlex's answer before its data had the
// retraction, which reads published.
const WAKEFIELD_WORK_UNFLAGGED: OpenAlexWork = {
  id: 'https://openalex.org/W2117847125',
  doi: 'https://doi.org/10.1016/s0140-6736(97)11096-0',
  type: 'article',
  is_retracted: false,
  ids: { openalex: 'https://openalex.org/W2117847125', doi: 'https://doi.org/10.1016/s0140-6736(97)11096-0', pmid: 'https://pubmed.ncbi.nlm.nih.gov/9500320' },
  publication_year: 1998,
};

test("PubMed's retraction stands against a record of the paper that reads published, whichever comes first", () => {
  const pubmed = () => PaperBuilder.create(adapter.mapToStandard(WAKEFIELD_SUMMARY));
  const enrichment = mapOpenAlexEnrichmentWork(WAKEFIELD_WORK_UNFLAGGED)!.enrichment;
  assert.equal(enrichment.publicationStatus, 'published');
  assert.equal(PaperBuilder.merge(pubmed(), enrichment, 'openalex').publicationStatus, 'retracted', 'OpenAlex enriches the PubMed record');

  const card = PaperBuilder.create(mapOpenAlexWork(WAKEFIELD_WORK_UNFLAGGED)!);
  assert.equal(PaperBuilder.merge(card, pubmed(), 'pubmed').publicationStatus, 'retracted', "PubMed's record joins OpenAlex's");
});

test('arXiv keeps the preprint default the builder used to hand everyone', () => {
  // arXiv is the one source whose silence really does mean preprint.
  const paper = PaperBuilder.create({ id: 'arxiv:1', sources: { primary: 'arxiv', enrichedBy: [] } });
  assert.equal(paper.publicationType, 'preprint');
});

// On 2026-10-24 the labels searched as phrases in every field matched
// affiliations and journal names, which the category check drops, and next to
// nothing for a label joined by "&". The query asks for the check's own terms
// in title and abstract, still without the protocol series or records dated
// after today.
test("the harvest query searches each category's terms in title and abstract, without the protocol series, up to today", (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T15:00:00Z') });

  assert.equal(
    pubmedCategoryQuery(['med.pubh']),
    '("public health"[tiab] OR "epidemiology"[tiab] OR "population health"[tiab] OR "disease burden"[tiab] OR "health policy"[tiab] OR "healthcare access"[tiab]) AND 1800/01/01:2026/10/20[dp] NOT ("1064-3745"[is] OR "1940-6029"[is])',
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
