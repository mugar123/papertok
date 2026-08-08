import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPaperTopicTags } from './paperTopicTags.js';
import { resolvePaperTopic, topicExplorerPath } from './topicNavigation.js';

test('keeps original arXiv categories ahead of later OpenAlex concepts', () => {
  const basePaper = {
    primaryCategory: 'astro-ph.CO',
    categories: ['astro-ph.CO', 'gr-qc', 'hep-ph'],
  };
  const before = buildPaperTopicTags(basePaper);
  const after = buildPaperTopicTags({
    ...basePaper,
    concepts: [
      { id: 'C1', display_name: 'Cosmology' },
      { id: 'C2', display_name: 'Dark matter' },
    ],
  });

  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.map(tag => tag.label), [
    'Relatividad General',
    'Altas Energías (Fenomenología)',
    'Cosmology',
    'Dark matter',
  ]);
});

test('deduplicates concepts that repeat a visible category label', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'astro-ph.CO',
    categories: ['astro-ph.CO', 'physics.optics'],
    concepts: [
      { id: 'C1', display_name: 'Óptica' },
      { id: 'C2', display_name: 'Photonics' },
    ],
  });

  assert.deepEqual(tags.map(tag => tag.label), ['Óptica', 'Photonics']);
});

test('hides PACS classification codes from visible paper topics', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'gr-qc',
    categories: ['gr-qc', '11.25.Tq', '03.65.Ud'],
    concepts: [
      { id: 'ads:pacs', display_name: '04.70.Dy' },
      { id: 'C1', display_name: 'Quantum gravity' },
    ],
  }, 4, 'en');

  assert.deepEqual(tags.map(tag => tag.label), ['Quantum gravity']);
});

test('uses readable area labels for valid arXiv codes outside the preference taxonomy', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'quant-ph',
    categories: ['quant-ph', 'nlin.CD', 'cs.CC', 'cs.IT', 'astro-ph.IM'],
    concepts: [{ id: 'C1', display_name: 'Quantum chaos' }],
  }, 4, 'en');

  assert.deepEqual(tags.map(tag => tag.label), [
    'Physics',
    'Computer Science',
    'Quantum chaos',
  ]);

  const fallbackTopic = resolvePaperTopic(tags[0].value, 'en');
  const fallbackUrl = new URL(topicExplorerPath(fallbackTopic), 'https://papertok.test');
  assert.equal(fallbackTopic.display_name, 'Physics');
  assert.equal(fallbackTopic.query, 'nlin.CD');
  assert.deepEqual(fallbackTopic.categoryIds, ['nlin.CD']);
  assert.equal(fallbackUrl.searchParams.get('name'), 'Physics');
  assert.equal(fallbackUrl.searchParams.get('q'), 'nlin.CD');
});

test('only emits semantic tags that resolve to navigable topics', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'astro-ph.CO',
    categories: ['astro-ph.CO', 'gr-qc'],
    concepts: [
      { id: 'mesh:D000077216', display_name: 'Spatial transcriptomics', source: 'pubmed' },
      'Quantum sensing',
      { id: 'provider:generic', display_name: 'Research Paper' },
      { id: 'provider:url', display_name: 'https://example.com/topic' },
      { id: 'provider:pacs', display_name: '04.70.Dy' },
    ],
  }, 10, 'en');

  assert.deepEqual(tags.map(tag => tag.label), [
    'General Relativity and Quantum Cosmology',
    'Spatial transcriptomics',
    'Quantum sensing',
  ]);
  assert.equal(tags.every(tag => Boolean(topicExplorerPath(resolvePaperTopic(tag.value, 'en')))), true);
});

test('recognizes every supported semantic label field', () => {
  const tags = buildPaperTopicTags({
    concepts: [
      { id: 'provider:one', display_name: 'Spatial transcriptomics' },
      { id: 'provider:two', displayName: 'Single-cell proteomics' },
      { id: 'provider:three', name: 'Quantum sensing' },
      { id: 'provider:four', label: 'Gene regulation' },
    ],
  }, 10, 'en');

  assert.deepEqual(tags.map(tag => tag.label), [
    'Spatial transcriptomics',
    'Single-cell proteomics',
    'Quantum sensing',
    'Gene regulation',
  ]);
});
