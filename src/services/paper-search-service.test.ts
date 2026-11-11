/**
 * The papers section, from both sources.
 *
 * Fixtures are what OpenAlex and arXiv actually answered through the Worker on
 * 2026-09-22 for the three searches that used to come back wrong, cut down to
 * the fields the ranking and the deduplication read. Live coverage is
 * `scripts/diagnostics/search-coverage-check.mjs`; this file pins the merge.
 */

import type { Paper } from '../models/paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARXIV_SEARCH_TIMEOUT_MS,
  DEFAULT_PAPER_SEARCH_PROVIDERS,
  openReviewSearchPapers,
  searchPapersAcrossSources,
} from './paper-search-service.ts';
import { OPENALEX_SEARCH_TYPES } from '../utils/open-alex-work.ts';
import type { OpenReviewNote } from './open-review-service.ts';
import { mapOpenReviewNote } from './open-review-service.ts';

const openAlexPaper = (id: string, title: string, extra: Partial<Paper> & { citations?: number } = {}): Paper => ({
  id: `openalex:${id}`,
  title,
  abstract: extra.abstract || 'No abstract available.',
  authors: extra.authors || [{ name: 'Someone Else' }],
  doi: extra.doi || null,
  arxivId: extra.arxivId,
  year: extra.year || 2024,
  citationsCount: extra.citations || 0,
  provider: 'openalex_search',
  sources: { primary: 'openalex', enrichedBy: [] },
});

const arxivPaper = (arxivId: string, title: string, extra: Partial<Paper> & { citations?: number } = {}): Paper => ({
  id: arxivId,
  arxivId,
  title,
  abstract: extra.abstract || '',
  authors: extra.authors || [{ name: 'Someone Else' }],
  doi: extra.doi || '',
  year: extra.year || 2023,
  sources: { primary: 'arxiv', enrichedBy: [] },
});

const providersWith = ({ openAlex = [], arxiv = [] }: { openAlex?: Paper[]; arxiv?: Paper[] } = {}) => ({
  searchOpenAlex: async () => ({ papers: openAlex, total: openAlex.length }),
  searchArxiv: async () => arxiv,
});

test('"llama 2": the paper OpenAlex cannot name arrives from arXiv and ranks first', async () => {
  const papers = await searchPapersAcrossSources('llama 2', {
    providers: providersWith({
      openAlex: [
        // Starts with "Llama 2" too, and OpenAlex ranks it above everything
        // arXiv adds: only the covered share of the title separates the two.
        openAlexPaper('W4385495736', "Llama 2: Early Adopters' Utilization of Meta's New Open-Source Pretrained Model", { citations: 31 }),
        openAlexPaper('W4392504747', 'Systematic analysis of ChatGPT, Google search and Llama 2 for clinical decision support', { citations: 211 }),
        openAlexPaper('W3166262177', 'Nanobodies from camelid mice and llamas neutralize SARS-CoV-2 variants', { citations: 253 }),
        openAlexPaper('W4392164233', 'Comparing the performance of ChatGPT GPT-4, Bard, and Llama-2 in the Taiwan Psychiatric Licensing Examination'),
      ],
      arxiv: [
        arxivPaper('2308.13032', 'Financial News Analytics Using Fine-Tuned Llama 2 GPT Model'),
        arxivPaper('2402.00402', 'Investigating Bias Representations in Llama 2 Chat via Activation Steering'),
        arxivPaper('2307.09288', 'Llama 2: Open Foundation and Fine-Tuned Chat Models', { authors: [{ name: 'Hugo Touvron' }] }),
      ],
    }),
  });

  assert.equal(papers[0].arxivId, '2307.09288');
  assert.equal(papers[0].title, 'Llama 2: Open Foundation and Fine-Tuned Chat Models');
  assert.equal(papers[1].title, "Llama 2: Early Adopters' Utilization of Meta's New Open-Source Pretrained Model");
  assert.equal(papers.length, 6);
  assert.ok(!papers.some(paper => paper.title.includes('Nanobodies')), 'unrelated llama token overlap is excluded');
});

test('"segment anything": the original from OpenAlex leads once conference papers are allowed', async () => {
  const papers = await searchPapersAcrossSources('segment anything', {
    providers: providersWith({
      openAlex: [
        openAlexPaper('W4390874575', 'Segment Anything', {
          doi: '10.1109/iccv51070.2023.00371', citations: 10567, authors: [{ name: 'Alexander Kirillov' }],
        }),
        openAlexPaper('W4391109864', 'Segment anything in medical images', { doi: '10.1038/s41467-024-44824-z', citations: 2823 }),
        openAlexPaper('W4385481295', 'Segment anything model for medical image analysis: An experimental study'),
      ],
      arxiv: [
        // The same paper under its arXiv id: one result, not two.
        arxivPaper('2304.02643', 'Segment Anything', { authors: [{ name: 'Alexander Kirillov' }] }),
        arxivPaper('2306.12156', 'Fast Segment Anything'),
      ],
    }),
  });

  assert.equal(papers[0].title, 'Segment Anything');
  assert.equal(papers.filter(paper => paper.title === 'Segment Anything').length, 1, 'merged, not duplicated');
  assert.equal(papers[0].arxivId, '2304.02643', 'the merged record knows its arXiv id');
  assert.equal(papers[0].doi, '10.1109/iccv51070.2023.00371', 'and keeps the DOI OpenAlex gave it');
});

test('"FC-CLIP": found through its abstract from either side and kept as one paper', async () => {
  const title = 'Convolutions Die Hard: Open-Vocabulary Segmentation with Single Frozen Convolutional CLIP';
  const abstract = 'We propose FC-CLIP, a single-stage framework built on a shared frozen convolutional CLIP backbone.';
  const papers = await searchPapersAcrossSources('FC-CLIP', {
    providers: providersWith({
      openAlex: [
        openAlexPaper('W2126518215', 'Respiratory sinus arrhythmia in humans: how breathing pattern modulates heart rate', { citations: 1107 }),
        openAlexPaper('W2894280539', 'Multilevel Language and Vision Integration for Text-to-Clip Retrieval', { citations: 339 }),
        openAlexPaper('W4385645314', title, { doi: '10.48550/arxiv.2308.02487', abstract, authors: [{ name: 'Qihang Yu' }] }),
      ],
      arxiv: [
        arxivPaper('2308.02487', title, { abstract, authors: [{ name: 'Qihang Yu' }] }),
      ],
    }),
  });

  assert.equal(papers[0].title, title);
  assert.equal(papers.filter(paper => paper.title === title).length, 1);
  assert.equal(papers[0].arxivId, '2308.02487');
});

test('the near-exact title ranks first wherever the provider put it', async () => {
  const title = 'Convolutions Die Hard: Open-Vocabulary Segmentation with Single Frozen Convolutional CLIP';
  const papers = await searchPapersAcrossSources(
    'Convolutions Die Hard: Open-Vocabulary Segmentation with Single Frozen Convolutional CLIP',
    {
      providers: providersWith({
        openAlex: [
          openAlexPaper('W4391547487', 'Towards Open Vocabulary Learning: A Survey', { citations: 159 }),
          openAlexPaper('W4385645314', title, { doi: '10.48550/arxiv.2308.02487' }),
        ],
        arxiv: [],
      }),
    },
  );
  assert.equal(papers[0].title, title);
});

test('a slow arXiv never holds the OpenAlex answer', async () => {
  const papers = await searchPapersAcrossSources('segment anything', {
    arxivTimeoutMs: 10,
    providers: {
      searchOpenAlex: async () => ({ papers: [openAlexPaper('W1', 'Segment Anything')] }),
      searchArxiv: () => new Promise(() => {}),
    },
  });
  assert.deepEqual(papers.map(paper => paper.title), ['Segment Anything']);
});

test('a dead arXiv leaves the OpenAlex answer whole', async () => {
  const papers = await searchPapersAcrossSources('segment anything', {
    providers: {
      searchOpenAlex: async () => ({ papers: [openAlexPaper('W1', 'Segment Anything')] }),
      searchArxiv: async () => { throw new Error('No se pudo conectar con arXiv'); },
    },
  });
  assert.equal(papers.length, 1);
});

test('a dead OpenAlex still shows what arXiv found', async () => {
  const papers = await searchPapersAcrossSources('llama 2', {
    providers: {
      searchOpenAlex: async () => { throw new Error('OpenAlex rate limit is active'); },
      searchArxiv: async () => [arxivPaper('2307.09288', 'Llama 2: Open Foundation and Fine-Tuned Chat Models')],
    },
  });
  assert.equal(papers[0].arxivId, '2307.09288');
});

test('both sources dead rejects with OpenAlex\'s own error, so the page can read the rate limit', async () => {
  const rateLimit = Object.assign(new Error('OpenAlex rate limit reached'), { code: 'rate_limited', status: 429 });
  await assert.rejects(
    searchPapersAcrossSources('llama 2', {
      providers: {
        searchOpenAlex: async () => { throw rateLimit; },
        searchArxiv: async () => [],
      },
    }),
    error => error === rateLimit,
  );
});

test('the slice is ten, after the merge and the ranking', async () => {
  const filler = Array.from({ length: 25 }, (_, index) => openAlexPaper(`W${index}`, `Derivative paper ${index} about segment anything`));
  const papers = await searchPapersAcrossSources('segment anything', {
    providers: providersWith({ openAlex: filler, arxiv: [arxivPaper('2304.02643', 'Segment Anything')] }),
  });
  assert.equal(papers.length, 10);
  assert.equal(papers[0].title, 'Segment Anything');
});

test('an empty query asks nobody', async () => {
  let asked = 0;
  const papers = await searchPapersAcrossSources('   ', {
    providers: { searchOpenAlex: async () => { asked += 1; }, searchArxiv: async () => { asked += 1; } },
  });
  assert.deepEqual(papers, []);
  assert.equal(asked, 0);
});

test('the default OpenAlex provider searches with the wider type list', async () => {
  // The default provider is the adapter with `types` pinned; it is checked by
  // shape here because it reaches the network. The value it pins is what the
  // adapter test verifies ends up in the filter.
  assert.equal(typeof DEFAULT_PAPER_SEARCH_PROVIDERS.searchOpenAlex, 'function');
  assert.equal(typeof DEFAULT_PAPER_SEARCH_PROVIDERS.searchArxiv, 'function');
  assert.deepEqual([...OPENALEX_SEARCH_TYPES], ['article', 'conference-paper', 'review', 'preprint']);
  assert.ok(ARXIV_SEARCH_TIMEOUT_MS < 6_000, 'inside the deadline the callers give the papers section');
});

test('a slow OpenAlex cannot discard an available arXiv paper and is cancelled', async () => {
  let upstreamSignal: AbortSignal | undefined;
  const papers = await searchPapersAcrossSources('llama 2', {
    openAlexTimeoutMs: 10,
    providers: {
      searchOpenAlex: (_query, options) => { upstreamSignal = options.signal; return new Promise(() => {}); },
      searchArxiv: async () => [arxivPaper('2307.09288', 'Llama 2: Open Foundation and Fine-Tuned Chat Models')],
    },
  });
  assert.equal(papers[0].arxivId, '2307.09288');
  assert.equal(upstreamSignal?.aborted, true);
});


test('title filtering preserves provider matches for identifiers', async () => {
  for (const query of ['hep-th/9901001', 'doi:10.1000/example', 'W12345']) {
    const papers = await searchPapersAcrossSources(query, {
      providers: providersWith({ openAlex: [openAlexPaper('W12345', 'A provider-identified work')], arxiv: [] }),
    });
    assert.equal(papers.length, 1, query);
  }
});

test('a query in another script is filtered by its titles like a Latin one', async () => {
  const papers = await searchPapersAcrossSources('深度学习', {
    providers: providersWith({ openAlex: [
      openAlexPaper('W1', 'A provider-identified work'),
      openAlexPaper('W2', '基于深度学习的图像识别技术研究'),
    ], arxiv: [] }),
  });
  assert.deepEqual(papers.map(paper => paper.id), ['openalex:W2']);
});

// What `/sources/openreview` answered on 2026-11-10 for this title, cut down
// to the fields these tests need. Neither OpenAlex nor arXiv has the paper.
const cognitiveSecurityNote: OpenReviewNote = {
  id: '5pShDP8LSm',
  forum: '5pShDP8LSm',
  domain: 'ICLR.cc/2026/Workshop/AIWILD',
  pdate: 1772406509750,
  content: {
    title: { value: 'Position: AI Development Should Prioritize Cognitive Security' },
    venue: { value: 'ICLR 2026 AIWILD' },
    venueid: { value: 'ICLR.cc/2026/Workshop/AIWILD' },
  },
};
const openReviewPaper = (note: OpenReviewNote = cognitiveSecurityNote) => mapOpenReviewNote(note)!;

test('a paper only OpenReview holds is found by its title', async () => {
  const papers = await searchPapersAcrossSources('Position: AI Development Should Prioritize Cognitive Security', {
    providers: {
      searchOpenAlex: async () => ({ papers: [openAlexPaper('W3081459360', 'Automated influence and the challenge of cognitive security')] }),
      searchArxiv: async () => [],
      searchOpenReview: async () => [openReviewPaper()],
    },
  });
  assert.deepEqual(papers.map(paper => paper.openReviewId), ['5pShDP8LSm']);
});

test('a slow OpenReview never holds the OpenAlex answer', async () => {
  const papers = await searchPapersAcrossSources('segment anything', {
    openReviewTimeoutMs: 10,
    providers: {
      searchOpenAlex: async () => ({ papers: [openAlexPaper('W1', 'Segment Anything')] }),
      searchArxiv: async () => [],
      searchOpenReview: () => new Promise(() => {}),
    },
  });
  assert.deepEqual(papers.map(paper => paper.title), ['Segment Anything']);
});

test('a dead OpenReview leaves the other answers whole', async () => {
  const papers = await searchPapersAcrossSources('segment anything', {
    providers: {
      searchOpenAlex: async () => ({ papers: [openAlexPaper('W1', 'Segment Anything')] }),
      searchArxiv: async () => [],
      searchOpenReview: async () => { throw new Error('/sources/openreview returned 502'); },
    },
  });
  assert.equal(papers.length, 1);
});

test('a dead OpenAlex still shows what OpenReview found', async () => {
  const papers = await searchPapersAcrossSources('Position: AI Development Should Prioritize Cognitive Security', {
    providers: {
      searchOpenAlex: async () => { throw new Error('OpenAlex rate limit is active'); },
      searchArxiv: async () => [],
      searchOpenReview: async () => [openReviewPaper()],
    },
  });
  assert.equal(papers[0].openReviewId, '5pShDP8LSm');
});

test('a submission OpenReview and arXiv both hold is one paper', async () => {
  const title = 'Llama 2: Open Foundation and Fine-Tuned Chat Models';
  const papers = await searchPapersAcrossSources('llama 2', {
    providers: {
      searchOpenAlex: async () => ({ papers: [] }),
      searchArxiv: async () => [arxivPaper('2307.09288', title)],
      searchOpenReview: async () => [openReviewPaper({
        ...cognitiveSecurityNote,
        content: { title: { value: title }, arxiv: { value: '2307.09288' } },
      })],
    },
  });
  assert.deepEqual(papers.map(paper => [paper.arxivId, paper.openReviewId]), [['2307.09288', '5pShDP8LSm']]);
});

test('an identifier is not sent to OpenReview, whose search matches text', async () => {
  const asked: string[] = [];
  await searchPapersAcrossSources('10.48550/arXiv.2307.09288', {
    providers: {
      ...providersWith(),
      searchOpenReview: async query => { asked.push(query); return []; },
    },
  });
  assert.deepEqual(asked, []);
});

test('an archive copy filed under one profile is not a search result', () => {
  // `/sources/openreview?q=llama 2` on 2026-11-10: the same paper twice, each
  // under the one author whose profile archived it.
  const archived = (id: string, author: string): OpenReviewNote => ({
    id,
    forum: id,
    domain: 'OpenReview.net/Archive',
    content: {
      title: { value: 'Llama 2: Open Foundation and Fine-Tuned Chat Models' },
      authors: { value: [author] },
    },
  });
  const papers = openReviewSearchPapers([
    archived('hGtV1kd9BA', 'Sharan Narang'),
    archived('UYZJpVEkvq', 'Amjad Almahairi'),
    cognitiveSecurityNote,
  ]);
  assert.deepEqual(papers.map(paper => paper.openReviewId), ['5pShDP8LSm']);
});

test('a pasted OpenReview link is looked up by its id, and nobody is asked to match its text', async () => {
  const asked: string[] = [];
  const providers = {
    searchOpenAlex: async () => { asked.push('openalex'); return { papers: [openAlexPaper('W1', 'Unrelated')] }; },
    searchArxiv: async () => { asked.push('arxiv'); return []; },
    searchOpenReview: async () => { asked.push('openreview search'); return []; },
    findOpenReviewPaper: async (id: string) => { asked.push(`openreview ${id}`); return id === '5pShDP8LSm' ? openReviewPaper() : null; },
  };
  const found = await searchPapersAcrossSources('https://openreview.net/forum?id=5pShDP8LSm', { providers });
  assert.deepEqual(found.map(paper => paper.openReviewId), ['5pShDP8LSm']);
  assert.deepEqual(await searchPapersAcrossSources('openreview:unknownNote', { providers }), []);
  assert.deepEqual(asked, ['openreview 5pShDP8LSm', 'openreview unknownNote']);
});

test('an OpenReview that cannot be reached for a pasted link rejects and names itself as the provider', async () => {
  await assert.rejects(
    searchPapersAcrossSources('https://openreview.net/forum?id=5pShDP8LSm', {
      providers: { ...providersWith(), findOpenReviewPaper: async () => { throw new Error('/sources/openreview returned 502'); } },
    }),
    (error: Error & { searchSource?: string }) => /returned 502/.test(error.message) && error.searchSource === 'openreview',
  );
});
