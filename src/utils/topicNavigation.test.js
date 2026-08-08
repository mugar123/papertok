import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getQueryTopicMetadata,
  paperMatchesLocalTopic,
  resolvePaperTopic,
  resolveQueryTopicRoute,
  topicExplorerPath,
} from './topicNavigation.js';

test('resolves a PaperTok category id as a reliable topic', () => {
  const topic = resolvePaperTopic('astro-ph.CO');
  assert.deepEqual(topic, { id: 'astro-ph.CO', label: 'Cosmología', type: 'topic', reliable: true });
  assert.equal(topicExplorerPath(topic), '/explorer/topic/astro-ph.CO');
});

test('maps an OpenAlex concept name to the local taxonomy when possible', () => {
  const topic = resolvePaperTopic({ id: 'https://openalex.org/C123', display_name: 'Cosmology' });
  assert.equal(topic.id, 'astro-ph.CO');
  assert.equal(topic.reliable, true);
});

test('keeps a stable external OpenAlex concept navigable', () => {
  const external = resolvePaperTopic({ id: 'https://openalex.org/C987', display_name: 'Emergent topic' });
  assert.deepEqual(external, { id: 'C987', label: 'Emergent topic', type: 'concept', reliable: false });
});

test('keeps a current OpenAlex topic navigable', () => {
  const topic = resolvePaperTopic({ id: 'https://openalex.org/T123', display_name: 'Emergent topic' });
  assert.deepEqual(topic, { id: 'T123', label: 'Emergent topic', type: 'topic', reliable: false });
  assert.equal(topicExplorerPath(topic), '/explorer/topic/T123');
});

test('creates a deterministic provider-neutral query topic for meaningful text', () => {
  const topic = resolvePaperTopic({
    id: 'mesh:D000077216',
    display_name: 'Spatial transcriptomics',
    source: 'pubmed',
  });
  const sameTopic = resolvePaperTopic('spatial transcriptomics');

  assert.match(topic.id, /^query-[a-f0-9]{8}$/);
  assert.equal(topic.id, sameTopic.id);
  assert.deepEqual(topic, {
    id: topic.id,
    display_name: 'Spatial transcriptomics',
    label: 'Spatial transcriptomics',
    query: 'Spatial transcriptomics',
    source: 'query',
    categoryIds: [],
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'pubmed',
      categoryIds: [],
    },
    type: 'topic',
    reliable: false,
    _queryTopic: true,
  });
});

test('query-topic paths restore exact display and query values after reload', () => {
  const topic = resolvePaperTopic({
    categoryId: 'nlin.CD',
    display_name: 'Physics',
    query: 'nlin.CD',
    source: 'arxiv',
  });
  const path = topicExplorerPath(topic);
  const url = new URL(path, 'https://papertok.test');
  const restored = resolveQueryTopicRoute(topic.id, url.searchParams);

  assert.equal(url.pathname, `/explorer/topic/${topic.id}`);
  assert.equal(url.searchParams.get('q'), 'nlin.CD');
  assert.equal(url.searchParams.get('name'), 'Physics');
  assert.equal(url.searchParams.get('source'), 'arxiv');
  assert.deepEqual(url.searchParams.getAll('category'), ['nlin.CD']);
  assert.deepEqual(restored, topic);
});

test('rejects generic, technical, malformed, and tampered query topics', () => {
  assert.equal(resolvePaperTopic('Research Paper'), null);
  assert.equal(resolvePaperTopic('04.70.Dy'), null);
  assert.equal(resolvePaperTopic('PMID: 12345'), null);
  assert.equal(resolvePaperTopic('query-deadbeef'), null);
  assert.equal(resolvePaperTopic('query-not-a-hash'), null);
  assert.equal(resolvePaperTopic('query-abc'), null);
  assert.equal(resolvePaperTopic('T123'), null);
  assert.equal(resolvePaperTopic('mesh:D000077216'), null);
  assert.equal(resolvePaperTopic('of'), null);
  assert.equal(resolvePaperTopic({ id: 'provider:missing-label' }), null);
  assert.equal(resolvePaperTopic({ id: 'https://openalex.org/C123', display_name: 'Unknown' }), null);
  assert.ok(resolvePaperTopic('AI'));

  const valid = resolvePaperTopic('Quantum sensing');
  assert.equal(resolveQueryTopicRoute(valid.id, new URLSearchParams('q=Different+topic')), null);
  assert.equal(resolveQueryTopicRoute('T123', new URLSearchParams('q=Quantum+sensing')), null);
});

test('recognizes every supported provider label field without exposing opaque ids', () => {
  for (const field of ['display_name', 'displayName', 'name', 'label']) {
    const topic = resolvePaperTopic({ id: 'mesh:D012345', [field]: 'Single-cell proteomics' });
    assert.equal(topic.label, 'Single-cell proteomics');
    assert.equal(topic.metadata.query, 'Single-cell proteomics');
  }

  assert.equal(resolvePaperTopic({ id: 'mesh:D012345', label: 'query-not-a-label' }), null);
});

test('keeps query-topic metadata bounded to query, source, and scientific categories', () => {
  const metadata = getQueryTopicMetadata({
    displayName: 'Spatial transcriptomics',
    metadata: {
      query: 'Spatial transcriptomics',
      source: 'PubMed Provider With A Needlessly Long Internal Name That Must Be Bounded',
      categoryIds: [...Array.from({ length: 14 }, () => 'nlin.CD'), 'not a category'],
      ignored: 'never persisted',
    },
  });

  assert.deepEqual(Object.keys(metadata), ['query', 'source', 'categoryIds']);
  assert.equal(metadata.query, 'Spatial transcriptomics');
  assert.ok(metadata.source.length <= 48);
  assert.deepEqual(metadata.categoryIds, ['nlin.CD']);
});

test('keeps exact category papers and rejects unrelated supplemental results', () => {
  const topic = { categoryIds: ['cond-mat.str-el'], display_name: 'Electrones Correlacionados', labelEn: 'Strongly Correlated Electrons' };
  assert.equal(paperMatchesLocalTopic({ categories: ['cond-mat.str-el'], title: 'A lattice model' }, topic), true);
  assert.equal(paperMatchesLocalTopic({ categories: ['physics.chem-ph'], title: 'Water dehydrogenation by scandium' }, topic), false);
  assert.equal(paperMatchesLocalTopic({ primaryCategory: 'cond-mat.str-el', categories: ['physics.chem-ph'], title: 'Water dehydrogenation by scandium' }, topic), false);
  assert.equal(paperMatchesLocalTopic({ categories: ['physics.chem-ph', 'cond-mat.str-el'], title: 'Water dehydrogenation by scandium' }, topic), false);
  assert.equal(paperMatchesLocalTopic({ categories: ['physics.general'], title: 'Strongly correlated electrons in a cavity' }, topic), true);
});
