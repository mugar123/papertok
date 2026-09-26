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
  // "Cosmology" is the paper's own primary category, already on the pill:
  // it is the same topic twice, so it is not repeated (2026-09-24).
  assert.deepEqual(after.map(tag => tag.label), [
    'General Relativity and Quantum Cosmology',
    'High Energy Physics - Phenomenology',
    'Dark matter',
  ]);
});

test('deduplicates concepts that repeat a visible category label', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'astro-ph.CO',
    categories: ['astro-ph.CO', 'physics.optics'],
    concepts: [
      { id: 'C1', display_name: 'Óptics' },
      { id: 'C2', display_name: 'Photonics' },
    ],
  });

  // "Óptics" folds to the visible "Optics" category chip and is dropped.
  assert.deepEqual(tags.map(tag => tag.label), ['Optics', 'Photonics']);
});

test('hides PACS classification codes from visible paper topics', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'gr-qc',
    categories: ['gr-qc', '11.25.Tq', '03.65.Ud'],
    concepts: [
      { id: 'ads:pacs', display_name: '04.70.Dy' },
      { id: 'C1', display_name: 'Quantum gravity' },
    ],
  }, 4);

  assert.deepEqual(tags.map(tag => tag.label), ['Quantum gravity']);
});

test('uses readable area labels for valid arXiv codes outside the preference taxonomy', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'quant-ph',
    categories: ['quant-ph', 'nlin.CD', 'cs.CC', 'cs.IT', 'astro-ph.IM'],
    concepts: [{ id: 'C1', display_name: 'Quantum chaos' }],
  }, 4);

  assert.deepEqual(tags.map(tag => tag.label), [
    'Physics',
    'Computer Science',
    'Quantum chaos',
  ]);

  const fallbackTopic = resolvePaperTopic(tags[0].value);
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
  }, 10);

  assert.deepEqual(tags.map(tag => tag.label), [
    'General Relativity and Quantum Cosmology',
    'Spatial transcriptomics',
    'Quantum sensing',
  ]);
  assert.equal(tags.every(tag => Boolean(topicExplorerPath(resolvePaperTopic(tag.value)))), true);
});

test('recognizes every supported semantic label field', () => {
  const tags = buildPaperTopicTags({
    concepts: [
      { id: 'provider:one', display_name: 'Spatial transcriptomics' },
      { id: 'provider:two', displayName: 'Single-cell proteomics' },
      { id: 'provider:three', name: 'Quantum sensing' },
      { id: 'provider:four', label: 'Gene regulation' },
    ],
  }, 10);

  assert.deepEqual(tags.map(tag => tag.label), [
    'Spatial transcriptomics',
    'Single-cell proteomics',
    'Quantum sensing',
    'Gene regulation',
  ]);
});

// A chip that is one of our own topics prints that topic's label and carries
// no `lang` override (audit 2026-09-23, issue 8).
test('a chip that is one of our topics prints our topic label', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'med.cardio',
    categories: ['med.cardio', 'Oncology'],
    concepts: [{ id: 'https://openalex.org/C41008148', display_name: 'Computer science' }],
  }, 4);

  assert.deepEqual(tags.map(tag => tag.label), ['Oncology', 'Computer Science']);
  assert.deepEqual(tags.map(tag => tag.lang), [undefined, undefined]);
});

test('provider text keeps its words and says they are English', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'med.onco',
    categories: ['med.onco', 'Tumor Microenvironment'],
    concepts: [{ id: 'C1', display_name: 'Dark matter' }],
  }, 4);

  assert.deepEqual(tags.map(tag => [tag.label, tag.lang]), [
    ['Tumor Microenvironment', 'en'],
    ['Dark matter', 'en'],
  ]);
});

test('our label for an arXiv code is ours, not provider text', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'quant-ph',
    categories: ['quant-ph', 'nlin.CD'],
  }, 4);

  assert.deepEqual(tags.map(tag => [tag.label, tag.lang]), [['Physics', undefined]]);
});

test('two chips that are the same topic show once, and never repeat the category pill', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'astro-ph.CO',
    categories: ['astro-ph.CO', 'med.onco', 'Oncology'],
    concepts: [{ id: 'C1', display_name: 'Cosmology' }, { id: 'C2', display_name: 'Oncology' }],
  }, 4);

  assert.deepEqual(tags.map(tag => tag.label), ['Oncology']);
});
