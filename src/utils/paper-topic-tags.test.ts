import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPaperTopicTags, getPaperClassification } from './paper-topic-tags.ts';
import { resolvePaperTopic, topicExplorerPath } from './topic-navigation.ts';

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

test('keeps distinct arXiv categories outside the preference taxonomy', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'quant-ph',
    categories: ['quant-ph', 'nlin.CD', 'cs.CC', 'cs.IT', 'astro-ph.IM'],
    concepts: [{ id: 'C1', display_name: 'Quantum chaos' }],
  }, 4);

  assert.deepEqual(tags.map(tag => tag.label), [
    'Chaotic Dynamics',
    'Computational Complexity',
    'Information Theory',
    'Instrumentation and Methods for Astrophysics',
  ]);

  const fallbackTopic = resolvePaperTopic(tags[0].value);
  const fallbackUrl = new URL(topicExplorerPath(fallbackTopic)!, 'https://papertok.test');
  assert.equal(fallbackTopic!.display_name, 'Chaotic Dynamics');
  assert.equal(fallbackTopic!.query, 'nlin.CD');
  assert.deepEqual(fallbackTopic!.categoryIds, ['nlin.CD']);
  assert.equal(fallbackUrl.searchParams.get('name'), 'Chaotic Dynamics');
  assert.equal(fallbackUrl.searchParams.get('q'), 'nlin.CD');
});

test('only emits semantic tags that resolve to navigable topics', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'astro-ph.CO',
    categories: ['astro-ph.CO', 'gr-qc'],
    concepts: [
      { id: 'mesh:D000077216', display_name: 'Spatial transcriptomics', source: 'pubmed' } as NonNullable<NonNullable<NonNullable<Parameters<typeof buildPaperTopicTags>[0]>["concepts"]>[number]> & Record<string, unknown>,
      'Quantum sensing' as string & import('../models/paper.ts').PaperSubject,
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
      { id: 'provider:three', name: 'Quantum sensing' } as NonNullable<NonNullable<NonNullable<Parameters<typeof buildPaperTopicTags>[0]>["concepts"]>[number]> & Record<string, unknown>,
      { id: 'provider:four', label: 'Gene regulation' } as NonNullable<NonNullable<NonNullable<Parameters<typeof buildPaperTopicTags>[0]>["concepts"]>[number]> & Record<string, unknown>,
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

  assert.deepEqual(tags.map(tag => [tag.label, tag.lang]), [['Chaotic Dynamics', undefined]]);
});

test('two chips that are the same topic show once, and never repeat the category pill', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'astro-ph.CO',
    categories: ['astro-ph.CO', 'med.onco', 'Oncology'],
    concepts: [{ id: 'C1', display_name: 'Cosmology' }, { id: 'C2', display_name: 'Oncology' }],
  }, 4);

  assert.deepEqual(tags.map(tag => tag.label), ['Oncology']);
});


test('distinct arXiv IDs survive identical labels while repeated IDs do not', () => {
  const tags = buildPaperTopicTags({
    primaryCategory: 'cs.IT',
    categories: ['cs.IT', 'math.IT', 'math.IT', 'cs.LG', 'stat.ML'],
  }, 10);
  assert.deepEqual(tags.map(tag => tag.key), ['category:math.IT', 'category:cs.LG', 'category:stat.ML']);
});


// Topic IDs/names observed on the five affected OpenAlex works, 2026-10-26.
test('the masthead uses an attributed OpenAlex topic instead of its broad field', () => {
  for (const [id, label, fieldId, fieldName, subfieldId, subfieldName] of [
    ["T10860", "Speech and Audio Processing", "17", "Computer Science", "1711", "Signal Processing"],
    ["T11130", "Coding theory and cryptography", "17", "Computer Science", "1702", "Artificial Intelligence"],
    ["T11323", "Gamma-ray bursts and supernovae", "31", "Physics and Astronomy", "3103", "Astronomy and Astrophysics"],
    ["T11513", "stochastic dynamics and bifurcation", "31", "Physics and Astronomy", "3109", "Statistical and Nonlinear Physics"],
    ["T12069", "Commutative Algebra and Its Applications", "26", "Mathematics", "2602", "Algebra and Number Theory"],
  ]) {
    const classification = getPaperClassification({
      categories: ['Unrelated concept'],
      primaryTopic: { id: `https://openalex.org/${id}`, display_name: label,
        field: { id: `https://openalex.org/fields/${fieldId}`, display_name: fieldName },
        subfield: { id: `https://openalex.org/subfields/${subfieldId}`, display_name: subfieldName },
      },
    });
    assert.equal(classification.label, label);
    assert.equal(classification.sourceLabel, 'OpenAlex topic');
    assert.equal(classification.topic?.id, id);
    assert.equal(topicExplorerPath(classification.topic), `/explorer/topic/${id}`);
  }
});

test('native categories take precedence over OpenAlex topics and concept order', () => {
  const classification = getPaperClassification({
    primaryCategory: 'cs.IT', categories: ['Unrelated concept', 'cs.IT', 'math.IT'],
    primaryTopic: { id: 'T11130', display_name: 'Coding theory and cryptography' },
  });
  assert.equal(classification.label, 'Information Theory');
  assert.equal(classification.sourceLabel, '');
  assert.deepEqual(classification.topic?.categoryIds, ['cs.IT']);
  assert.equal(getPaperClassification({ categories: ['Unrelated concept', 'math.AC'] }).label, 'Commutative Algebra');
});

test('missing and technical-only classifications stay unknown', () => {
  for (const paper of [{}, { categories: ['04.70.Dy'] }, { categories: ['query-deadbeef'] }]) {
    assert.deepEqual(getPaperClassification(paper), { label: 'Research Paper', sourceLabel: '', topic: null });
  }
  assert.equal(getPaperClassification({ journal: 'Nature' }).label, 'Nature');
  assert.deepEqual(getPaperClassification({ primaryTopic: { id: 'T1', field: { id: '17', display_name: 'Computer Science' } } }),
    { label: 'Computer Science', sourceLabel: '', topic: null });
});


test('secondary tags exclude the classification actually printed in the masthead', () => {
  const native = { categories: ['Unrelated concept', 'math.AC'] };
  assert.equal(getPaperClassification(native).label, 'Commutative Algebra');
  assert.deepEqual(buildPaperTopicTags(native).map(tag => tag.key), ['category:Unrelated concept']);
  const external = { primaryTopic: { id: 'T11130', display_name: 'Coding theory and cryptography' },
    concepts: [{ id: 'T11130', display_name: 'Coding theory and cryptography' }] };
  assert.deepEqual(buildPaperTopicTags(external), []);
});
