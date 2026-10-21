import test from 'node:test';
import assert from 'node:assert/strict';
import { toRewriteSection } from '../models/Rewrite.ts';
import { getPaperKey } from '../utils/publicNavigation.ts';
import { canRewritePaper, getRewritablePdfUrl } from './paperRewriteService.ts';
import {
  buildSummaryHistoryQuery,
  buildSummaryWrite,
  listSummaryHistory,
  SUMMARY_HISTORY_PAGE_SIZE,
  summaryHistoryPaper,
  summaryId,
  toSummaryHistoryRow,
} from './savedSummaryService.ts';

const PDF = 'https://arxiv.org/pdf/2401.00001.pdf';
const SECTION = {
  id: 's0',
  kind: 'intro',
  heading: 'What they asked',
  originalHeading: '1 Introduction',
  paragraphs: ['First paragraph.', 'Second paragraph.'],
  highlights: [{ paragraphIndex: 1, quote: 'Second paragraph', kind: 'finding' }],
};
const PAPER = { id: '2401.00001v1', arxivId: '2401.00001v1', title: 'A paper about $x^2$' };

test('one summary per paper and level, under the canonical paper key', () => {
  const id = summaryId(PAPER, 'university');
  assert.equal(id, `${getPaperKey(PAPER)}.university`);
  assert.equal(summaryId({ ...PAPER, openAccessPdfUrl: PDF } as typeof PAPER, 'university'), id);
  assert.notEqual(summaryId(PAPER, 'beginner'), id);
  assert.equal(summaryId(PAPER, 'expert'), null);
  // A Semantic Scholar hash names no paper another open could find again.
  assert.equal(summaryId({ id: '649def34f8be52c8b66281af98ae884c09aef38b', title: 'T' }, 'university'), null);
});

test('a finished rewrite becomes the text and a history row that can reopen it', () => {
  const write = buildSummaryWrite(PAPER, 'researcher', { sections: [SECTION], model: 'deepseek-v4-flash', sourceBasis: 'full_text', promptVersion: 'paper-rewrite-v3' }, PDF);
  assert.deepEqual(write, {
    id: `${getPaperKey(PAPER)}.researcher`,
    summary: { sections: [SECTION], model: 'deepseek-v4-flash', sourceBasis: 'full_text', promptVersion: 'paper-rewrite-v3' },
    history: {
      paperKey: getPaperKey(PAPER),
      paperId: '2401.00001v1',
      level: 'researcher',
      title: 'A paper about $x^2$',
      pdfUrl: PDF,
    },
  });
});

test('an unknown source basis stays unknown rather than being called full text', () => {
  const write = buildSummaryWrite(PAPER, 'university', { sections: [SECTION], model: '', sourceBasis: undefined as unknown as string, promptVersion: '' }, PDF);
  assert.equal(write!.summary.sourceBasis, '');
});

test('an unknown prompt version stays unknown rather than being called the current one', () => {
  const write = buildSummaryWrite(PAPER, 'university', { sections: [SECTION], model: 'm', sourceBasis: 'full_text', promptVersion: undefined as unknown as string }, PDF);
  assert.equal(write!.summary.promptVersion, '');
});

test('nothing is kept without a title, a PDF or a whole set of sections', () => {
  const summary = { sections: [SECTION], model: 'm', sourceBasis: 'full_text', promptVersion: 'paper-rewrite-v3' };
  assert.equal(buildSummaryWrite({ ...PAPER, title: '' }, 'university', summary, PDF), null);
  assert.equal(buildSummaryWrite(PAPER, 'university', summary, ''), null);
  assert.equal(buildSummaryWrite(PAPER, 'university', { ...summary, sections: [] }, PDF), null);
  assert.equal(buildSummaryWrite(PAPER, 'university', { ...summary, sections: [SECTION, { ...SECTION, paragraphs: ['ok', 42] } as never] }, PDF), null);
});

test('a stored section with a paragraph that is not text is refused whole', () => {
  // Dropping only the bad paragraph would move every later index, and the
  // reader anchors highlights and notes by paragraph index.
  assert.equal(toRewriteSection({ ...SECTION, paragraphs: ['First.', null, 'Third.'] }), null);
  assert.equal(toRewriteSection({ ...SECTION, id: '' }), null);
  assert.deepEqual(toRewriteSection({
    ...SECTION,
    highlights: [...SECTION.highlights, { paragraphIndex: 9, quote: 'nowhere', kind: 'finding' }, { paragraphIndex: 0, quote: '', kind: 'x' }],
  }), SECTION);
});

function fakeHistory(rowCount: number) {
  const calls: { segments: string[][]; orders: unknown[][]; afters: unknown[]; caps: number[] } = { segments: [], orders: [], afters: [], caps: [] };
  const docs = Array.from({ length: rowCount }, (_, index) => {
    const paper = { arxivId: `2401.${String(index).padStart(5, '0')}`, id: `2401.${String(index).padStart(5, '0')}`, title: `Paper ${index}` };
    const write = buildSummaryWrite(paper, 'university', { sections: [SECTION], model: 'm', sourceBasis: 'full_text', promptVersion: 'paper-rewrite-v3' }, PDF)!;
    return {
      id: write.id,
      data: () => ({ ...write.history, updatedAt: { toDate: () => new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - index * 60_000) } }),
    };
  });
  const overrides = {
    collectionRef: ((_database: unknown, ...segments: string[]) => {
      calls.segments.push(segments);
      return { segments };
    }) as never,
    order: ((...args: unknown[]) => { calls.orders.push(args); return { kind: 'order' }; }) as never,
    after: ((cursor: unknown) => { calls.afters.push(cursor); return { kind: 'after' }; }) as never,
    cap: ((count: number) => { calls.caps.push(count); return { kind: 'limit' }; }) as never,
    composeQuery: ((...parts: unknown[]) => ({ parts })) as never,
    readDocuments: (async () => ({ docs })) as never,
  };
  return { calls, overrides, docs };
}

test('the history asks for one page, newest first, then the page after the last row', () => {
  const { calls, overrides } = fakeHistory(0);
  buildSummaryHistoryQuery('uid-1', null, overrides);
  const cursor = { id: 'last-row' };
  buildSummaryHistoryQuery('uid-1', cursor as never, overrides);
  assert.deepEqual(calls.segments, [['users', 'uid-1', 'summaryHistory'], ['users', 'uid-1', 'summaryHistory']]);
  assert.deepEqual(calls.orders, [['updatedAt', 'desc'], ['updatedAt', 'desc']]);
  assert.deepEqual(calls.afters, [cursor]);
  assert.deepEqual(calls.caps, [SUMMARY_HISTORY_PAGE_SIZE + 1, SUMMARY_HISTORY_PAGE_SIZE + 1]);
});

test('a page offers more only when the extra row came back', async () => {
  const full = fakeHistory(SUMMARY_HISTORY_PAGE_SIZE + 1);
  const page = await listSummaryHistory('uid-1', {}, full.overrides);
  assert.equal(page.rows.length, SUMMARY_HISTORY_PAGE_SIZE);
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, full.docs[SUMMARY_HISTORY_PAGE_SIZE - 1]);
  assert.equal(page.rows[0].title, 'Paper 0');
  assert.equal(page.rows[0].updatedAt!.toISOString(), '2026-10-20T12:00:00.000Z');

  const last = await listSummaryHistory('uid-1', {}, fakeHistory(3).overrides);
  assert.equal(last.rows.length, 3);
  assert.equal(last.hasMore, false);
});

test('a history row that does not match its own id is not listed', () => {
  const write = buildSummaryWrite(PAPER, 'university', { sections: [SECTION], model: 'm', sourceBasis: 'full_text', promptVersion: 'paper-rewrite-v3' }, PDF)!;
  assert.ok(toSummaryHistoryRow(write.id, write.history));
  assert.equal(toSummaryHistoryRow(write.id, { ...write.history, level: 'beginner' }), null);
  assert.equal(toSummaryHistoryRow(write.id, { ...write.history, title: '' }), null);
  assert.equal(toSummaryHistoryRow(write.id, { ...write.history, pdfUrl: 'javascript:alert(1)' }), null);
});

for (const paper of [
  { label: 'an arXiv', id: '2401.00001v1', arxivId: '2401.00001v1', title: 'An arXiv paper', openAccessPdfUrl: PDF },
  { label: 'a DOI', id: 'openalex:W2741809807', doi: '10.1038/S41586-020-2649-2', title: 'A journal paper', openAccessPdfUrl: 'https://europepmc.org/articles/PMC7759461?pdf=render' },
  { label: 'an OpenAlex', id: 'openalex:W2741809807', title: 'An OpenAlex paper', openAccessPdfUrl: PDF },
  { label: 'a PubMed', id: 'pmid:31452104', pmid: '31452104', title: 'A PubMed paper', pmcid: 'PMC6713506' },
]) {
  test(`${paper.label} paper reopens from history with the same summary and PDF`, () => {
    const pdfUrl = getRewritablePdfUrl(paper);
    const write = buildSummaryWrite(paper, 'beginner', { sections: [SECTION], model: 'm', sourceBasis: 'full_text', promptVersion: 'paper-rewrite-v3' }, pdfUrl)!;
    const reopened = summaryHistoryPaper(toSummaryHistoryRow(write.id, write.history)!);
    assert.equal(summaryId(reopened, 'beginner'), write.id);
    assert.equal(reopened.id, paper.id);
    assert.equal(getRewritablePdfUrl(reopened), pdfUrl);
    assert.equal(canRewritePaper(reopened), true);
  });
}
