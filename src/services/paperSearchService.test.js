/**
 * The papers section, from both sources.
 *
 * Fixtures are what OpenAlex and arXiv actually answered through the Worker on
 * 2026-09-22 for the three searches that used to come back wrong, cut down to
 * the fields the ranking and the deduplication read. Live coverage is
 * `scripts/diagnostics/search-coverage-check.mjs`; this file pins the merge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARXIV_SEARCH_TIMEOUT_MS,
  DEFAULT_PAPER_SEARCH_PROVIDERS,
  searchPapersAcrossSources,
} from './paperSearchService.js';
import { OPENALEX_SEARCH_TYPES } from './adapters/OpenAlexAdapter.js';

const openAlexPaper = (id, title, extra = {}) => ({
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

const arxivPaper = (arxivId, title, extra = {}) => ({
  id: arxivId,
  arxivId,
  title,
  abstract: extra.abstract || '',
  authors: extra.authors || [{ name: 'Someone Else' }],
  doi: extra.doi || '',
  year: extra.year || 2023,
  sources: { primary: 'arxiv', enrichedBy: [] },
});

const providersWith = ({ openAlex = [], arxiv = [] } = {}) => ({
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
  assert.equal(papers.length, 7);
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
  assert.deepEqual([...OPENALEX_SEARCH_TYPES], ['article', 'conference-paper', 'preprint', 'review']);
  assert.ok(ARXIV_SEARCH_TIMEOUT_MS < 6_000, 'inside the deadline the callers give the papers section');
});
