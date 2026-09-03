import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePaperTopic } from '../utils/topicNavigation.js';
import {
  fetchTopicPapers,
  getFollowedTopicCategoryIds,
  resolveTopicRetrievalPlan,
} from './topicRetrievalService.js';

test('resolves exact ids and categories before stored query and legacy display names', () => {
  assert.deepEqual(resolveTopicRetrievalPlan({
    type: 'topic',
    canonicalId: 'T123',
    displayName: 'Legacy label',
    metadata: { query: 'Stored query', categoryIds: [] },
  }, { allowLegacyDisplayName: true }), {
    canonicalId: 'T123',
    openAlexId: 'T123',
    categoryIds: [],
    query: '',
    querySource: 'exact-id',
    isQueryTopic: false,
    valid: true,
  });

  const queryTopic = resolvePaperTopic('Spatial transcriptomics');
  const stored = resolveTopicRetrievalPlan({
    canonicalId: queryTopic.id,
    displayName: 'Wrong legacy label',
    metadata: { query: 'Spatial transcriptomics', source: 'pubmed', categoryIds: [] },
  }, { allowLegacyDisplayName: true });
  assert.equal(stored.query, 'Spatial transcriptomics');
  assert.equal(stored.querySource, 'metadata');

  const legacy = resolveTopicRetrievalPlan({ canonicalId: 'legacy-topic', displayName: 'Quantum sensing' }, {
    allowLegacyDisplayName: true,
  });
  assert.equal(legacy.query, 'Quantum sensing');
  assert.equal(legacy.querySource, 'legacy-display-name');
});

test('never turns malformed or opaque query ids into retrieval text', () => {
  for (const canonicalId of ['query-bad', 'query-abc', 'query-deadbeef-extra']) {
    const plan = resolveTopicRetrievalPlan({ canonicalId, displayName: canonicalId }, {
      allowLegacyDisplayName: true,
    });
    assert.equal(plan.valid, false);
    assert.equal(plan.query, '');
  }

  const valid = resolvePaperTopic('Quantum sensing');
  const tampered = resolveTopicRetrievalPlan({
    canonicalId: valid.id,
    displayName: valid.label,
    metadata: { query: 'Different topic', categoryIds: [] },
  }, { allowLegacyDisplayName: true });
  assert.equal(tampered.valid, false);
  assert.equal(tampered.query, '');
});

test('returns only scientific category ids for feed preferences', () => {
  const queryTopic = resolvePaperTopic('Spatial transcriptomics');
  assert.deepEqual(getFollowedTopicCategoryIds([
    { type: 'topic', canonicalId: queryTopic.id, displayName: queryTopic.label, metadata: queryTopic.metadata },
    { type: 'topic', canonicalId: 'physics.optics', displayName: 'Optics' },
    { type: 'author', canonicalId: 'A1', displayName: 'Ada' },
  ]), ['physics.optics']);
});

test('returns relevant partial successes and deduplicates provider records', async () => {
  const queryTopic = resolvePaperTopic('Spatial transcriptomics');
  const relevant = {
    id: 'arxiv:one',
    doi: '10.1000/shared',
    title: 'Spatial transcriptomics maps the heart',
    authors: [{ name: 'Ada Lovelace' }],
  };
  const duplicate = {
    id: 'openalex:W1',
    doi: 'https://doi.org/10.1000/shared',
    title: 'A tissue atlas',
    authors: [{ name: 'Ada Lovelace' }],
    concepts: [{ displayName: 'Spatial transcriptomics' }],
    citationCount: 8,
  };
  const unrelated = { id: 'unrelated', title: 'Urban spatial statistics', authors: [{ name: 'Grace Hopper' }] };
  const calls = [];
  const providers = {
    searchArxiv: async (query) => {
      calls.push(['arxiv', query]);
      return [relevant, unrelated];
    },
    searchOpenAlex: async (query) => {
      calls.push(['openalex', query]);
      throw new Error('OpenAlex unavailable');
    },
    searchPubmed: async (query) => {
      calls.push(['pubmed', query]);
      return { papers: [duplicate] };
    },
  };

  const result = await fetchTopicPapers(queryTopic, { providers, pageSize: 10 });

  assert.equal(result.partial, true);
  assert.deepEqual(result.failedProviders, ['openalex-query']);
  assert.deepEqual(result.successfulProviders, ['arxiv-query', 'pubmed-query']);
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].citationCount, 8);
  assert.equal(result.papers.some(paper => paper.id === 'unrelated'), false);
  assert.equal(calls.every(([, query]) => query.includes('Spatial transcriptomics')), true);
});

test('settles synchronous provider failures independently', async () => {
  const topic = resolvePaperTopic('Quantum sensing');
  const result = await fetchTopicPapers(topic, {
    providers: {
      searchArxiv: () => { throw new Error('arXiv unavailable'); },
      searchOpenAlex: () => ({ papers: [{ id: 'openalex-1', title: 'Quantum sensing methods' }] }),
      searchPubmed: () => { throw new Error('PubMed unavailable'); },
    },
  });

  assert.deepEqual(result.failedProviders, ['arxiv-query', 'pubmed-query']);
  assert.deepEqual(result.successfulProviders, ['openalex-query']);
  assert.equal(result.partial, true);
  assert.deepEqual(result.papers.map(paper => paper.id), ['openalex-1']);
});

test('keeps exact category results ahead of metadata-query supplements', async () => {
  const topic = resolvePaperTopic({
    categoryId: 'nlin.CD',
    displayName: 'Nonlinear dynamics',
    query: 'chaotic dynamics',
    source: 'provider',
  });
  const providers = {
    fetchArxivCategories: async categories => [{
      id: 'exact',
      title: 'An exact category paper',
      categories,
      authors: [{ name: 'Exact Author' }],
    }],
    fetchDomainCategories: async () => [],
    searchArxiv: async () => [{
      id: 'generic',
      title: 'Chaotic dynamics in coupled systems',
      authors: [{ name: 'Query Author' }],
    }],
    searchOpenAlex: async () => ({ papers: [] }),
    searchPubmed: async () => ({ papers: [] }),
  };

  const result = await fetchTopicPapers(topic, { providers, pageSize: 10 });
  assert.equal(result.plan.query, 'chaotic dynamics');
  assert.deepEqual(result.papers.map(paper => paper.id), ['exact', 'generic']);
});

test('excluded providers are not asked, and the exact category request still is', async () => {
  const topic = { canonicalId: 'cs.NI', displayName: 'Networking and Internet Architecture', metadata: { categoryIds: ['cs.NI'] } };
  const calls = [];
  const providers = {
    fetchArxivCategories: async () => { calls.push('cat'); return [{ id: 'exact', title: 'An exact category paper', authors: [{ name: 'Exact Author' }] }]; },
    fetchDomainCategories: async () => { calls.push('domain'); return []; },
    searchArxiv: async () => { calls.push('arxiv-query'); return []; },
    searchOpenAlex: async () => { calls.push('openalex-query'); return { papers: [] }; },
    searchPubmed: async () => { calls.push('pubmed-query'); return { papers: [] }; },
  };
  const result = await fetchTopicPapers(topic, { providers, pageSize: 5, excludeProviders: ['searchArxiv', 'searchPubmed'] });
  assert.deepEqual([...calls].sort(), ['cat', 'domain', 'openalex-query']);
  assert.deepEqual(result.papers.map(paper => paper.id), ['exact']);
  assert.deepEqual(result.failedProviders, []);
});
