import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  areaKeyForCategory,
  areaKeyForOpenAlexField,
  areaKeyForPaper,
  areaAccentForPaper,
  areaLabelForPaper,
  openAlexNotableFilterForLeaf,
  openAlexTopicFilterForLeaf,
} from './area-accent.ts';
import { OPENALEX_NOTABLE_LEAF_TOPICS } from '../data/open-alex-notable-leaf-topics.generated.ts';
import { openAlexFilterForArea } from '../data/open-alex-areas.ts';
import type { OpenAlexWork } from '../services/adapters/open-alex-types.ts';
import { CATEGORIES, getCategoryLabel } from '../data/category-taxonomy.ts';
import { OpenAlexAdapter } from '../services/adapters/open-alex-adapter.ts';
import { PaperBuilder } from '../services/paper-builder.ts';

/* Area grouping drives the accent and watermark. The masthead can name a
   more specific native category or an explicitly attributed OpenAlex topic. */

test('an arXiv category resolves exactly, then by its archive', () => {
  assert.equal(areaKeyForCategory('cs.AI'), 'ai');
  assert.equal(areaKeyForCategory('quant-ph'), 'physics');
  // Not listed explicitly, reached by its archive.
  assert.equal(areaKeyForCategory('cs.IT'), 'cs');
});

/* Every category in arXiv's taxonomy (arxiv.org/category_taxonomy, 155 as of
   October 2026), under the area that lists it or else the area its archive
   belongs to. */
const ARXIV_CATEGORIES_BY_AREA: Record<string, string[]> = {
  cs: 'AR CC CE CG CR CY DB DC DL DM DS ET FL GL GR GT HC IR IT LO MA MM MS NA NI OH OS PF PL RO SC SD SE SI SY'.split(' ').map(id => `cs.${id}`),
  ai: 'AI CL CV LG NE'.split(' ').map(id => `cs.${id}`),
  econ: ['econ.EM', 'econ.GN', 'econ.TH'],
  eess: ['eess.AS', 'eess.IV', 'eess.SP', 'eess.SY'],
  math: 'AC AG AP AT CA CO CT CV DG DS FA GM GN GR GT HO IT KT LO MG MP NA NT OA OC PR QA RA RT SG SP ST'.split(' ').map(id => `math.${id}`),
  physics: [
    ...'CO EP GA HE IM SR'.split(' ').map(id => `astro-ph.${id}`),
    ...'dis-nn mes-hall mtrl-sci other quant-gas soft stat-mech str-el supr-con'.split(' ').map(id => `cond-mat.${id}`),
    'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th', 'math-ph', 'nucl-ex', 'nucl-th', 'quant-ph',
    ...'AO CD CG PS SI'.split(' ').map(id => `nlin.${id}`),
    ...'acc-ph ao-ph app-ph atm-clus atom-ph bio-ph chem-ph class-ph comp-ph data-an ed-ph flu-dyn gen-ph geo-ph hist-ph ins-det med-ph optics plasm-ph pop-ph soc-ph space-ph'.split(' ').map(id => `physics.${id}`),
  ],
  bio: 'BM CB GN MN NC OT PE QM SC TO'.split(' ').map(id => `q-bio.${id}`),
  'q-fin': 'CP EC GN MF PM PR RM ST TR'.split(' ').map(id => `q-fin.${id}`),
  stat: 'AP CO ME ML OT TH'.split(' ').map(id => `stat.${id}`),
};
const ARXIV_CATEGORY_AREAS = Object.entries(ARXIV_CATEGORIES_BY_AREA)
  .flatMap(([area, ids]) => ids.map(id => [id, area] as const));

// Guessed from the first letters of the id, `math.AC` and `q-bio.NC` read as
// physics (`math-ph`, `quant-ph`) and `nlin.CD` as no field at all.
test('every arXiv category resolves to the area that lists it, else its archive\'s', () => {
  assert.equal(ARXIV_CATEGORY_AREAS.length, 155);
  assert.deepEqual(
    Object.fromEntries(ARXIV_CATEGORY_AREAS.map(([id]) => [id, areaKeyForCategory(id)])),
    Object.fromEntries(ARXIV_CATEGORY_AREAS),
  );
});

test("every arXiv category has a specific label and keeps its area's ink", () => {
  for (const [id, areaKey] of ARXIV_CATEGORY_AREAS) {
    const area = CATEGORIES[areaKey];
    const paper = { primaryCategory: id, categories: [id] };
    assert.notEqual(getCategoryLabel(id), id, id);
    if (!area.subcategories[id]) assert.notEqual(getCategoryLabel(id), area.label, id);
    assert.equal(areaLabelForPaper(paper), area.label, id);
    assert.equal(areaAccentForPaper(paper), area.gradient, id);
  }
});

// ENG-113. arXiv 1706.03762 (Attention Is All You Need), as listed on arxiv.org:
// primary cs.CL, cross-listed cs.LG. It reads as AI without either id changing.
test('a language paper groups under Artificial Intelligence and keeps its arXiv categories', () => {
  const paper = PaperBuilder.create({ id: '1706.03762', title: 'Attention Is All You Need', primaryCategory: 'cs.CL', categories: ['cs.CL', 'cs.LG'] });
  assert.equal(areaKeyForPaper(paper), 'ai');
  assert.equal(areaLabelForPaper(paper), 'Artificial Intelligence');
  assert.equal(areaAccentForPaper(paper), 'var(--gradient-ai)');
  assert.deepEqual([paper.primaryCategory, paper.categories], ['cs.CL', ['cs.CL', 'cs.LG']]);
});

test('an exact hit outranks a prefix hit, whatever the declaration order', () => {
  // Physics is declared before maths and owns `math-ph`, whose key starts with
  // "math" — so a prefix-first pass painted every number-theory paper physics.
  assert.equal(areaKeyForCategory('math.NT'), 'math');
  assert.equal(areaKeyForCategory('math-ph'), 'physics');
});

test('an OpenAlex field id resolves, by number or by URL', () => {
  assert.equal(areaKeyForOpenAlexField(17), 'cs');
  assert.equal(areaKeyForOpenAlexField('https://openalex.org/fields/26'), 'math');
  assert.equal(areaKeyForOpenAlexField({ id: 'https://openalex.org/fields/31' }), 'physics');
  assert.equal(areaKeyForOpenAlexField(9999), null);
  assert.equal(areaKeyForOpenAlexField(null), null);
});

// OpenAlex files mechanical, aerospace and civil work under Engineering and
// finance under Economics, so by field alone they read as Electrical &
// Electronic Engineering and Economics, and the Explorer's filter for their
// own area never found them.
test('an OpenAlex subfield that belongs elsewhere outranks its field', () => {
  const work = (subfield: number, field: number) => ({
    primaryTopic: { subfield: { id: `https://openalex.org/subfields/${subfield}` }, field: { id: `https://openalex.org/fields/${field}` } },
  } as Parameters<typeof areaKeyForPaper>[0]);
  assert.equal(areaKeyForPaper(work(2210, 22)), 'mech');
  assert.equal(areaKeyForPaper(work(2202, 22)), 'mech');
  assert.equal(areaKeyForPaper(work(2205, 22)), 'civil');
  assert.equal(areaKeyForPaper(work(2208, 22)), 'eess');
  assert.equal(areaKeyForPaper(work(2003, 20)), 'q-fin');
  assert.equal(areaKeyForPaper(work(2002, 20)), 'econ');
  assert.equal(areaKeyForPaper(work(2506, 25)), 'chemeng');
  assert.equal(areaKeyForPaper(work(1702, 17)), 'ai');
  assert.equal(areaKeyForPaper(work(1707, 17)), 'ai');
  assert.equal(areaKeyForPaper(work(1705, 17)), 'cs');
});

// What the Explorer asks OpenAlex for is what its rows are labelled with, and
// no area of the filter sheet goes to OpenAlex unfiltered.
test('every area has an OpenAlex filter built from the tables that label its rows', () => {
  for (const area of Object.keys(CATEGORIES)) {
    assert.ok(openAlexFilterForArea(area), `${area} has no OpenAlex filter`);
  }
  assert.equal(openAlexFilterForArea('cs'), 'primary_topic.field.id:17');
  assert.equal(openAlexFilterForArea('chemeng'), 'primary_topic.field.id:15|25');
  assert.equal(openAlexFilterForArea('mech'), 'primary_topic.subfield.id:2202|2203|2206|2210|2211');
  assert.equal(openAlexFilterForArea('q-fin'), 'primary_topic.subfield.id:2003');
  assert.equal(openAlexFilterForArea('ai'), 'primary_topic.subfield.id:1702|1707');
  assert.equal(openAlexFilterForArea('nonsense'), null);
});

/* ENG-129. A leaf's notable lane lists the topics its topic lane asks for;
   a leaf without one lists the topics its own blind sample found on target,
   articles only. Neither map holds a leaf of the other. */
test("a leaf's notable filter is its topic lane's, else its notable sample's, else none", () => {
  assert.equal(openAlexNotableFilterForLeaf('cs.CV'), openAlexTopicFilterForLeaf('cs.CV'));
  assert.equal(openAlexNotableFilterForLeaf('mech.aero'), openAlexTopicFilterForLeaf('mech.aero'), 'the conference papers too');
  for (const [leaf, topics] of Object.entries(OPENALEX_NOTABLE_LEAF_TOPICS)) {
    assert.equal(openAlexTopicFilterForLeaf(leaf), null, `${leaf} has no topic lane`);
    assert.equal(openAlexNotableFilterForLeaf(leaf), `primary_topic.id:${[...topics].sort().join('|')},type:article`);
  }
  assert.equal(openAlexNotableFilterForLeaf('nlin.CD'), null);
});

/* PAP-60. A name says what a topic is about, not which field filed it: read
   for keywords, "Somatic cell nuclear transfer" made a Genetics paper
   Physics, and a Chemistry paper took the field of whichever concept name
   matched first. */
test("a topic's or a concept's name alone is not a field", () => {
  for (const name of ['Wastewater Treatment and Reuse', 'Protein Structure and Dynamics', 'Somatic cell nuclear transfer']) {
    assert.equal(areaKeyForPaper({ categories: [name] }), null, name);
    assert.equal(areaKeyForPaper({ primaryCategory: name, categories: [name] }), null, name);
  }
});

// D3: OpenAlex fields this app has no area for (Social Sciences,
// Psychology...) read as OpenAlex names them, with no field's ink.
test('a field the app has no area for reads as OpenAlex names it, without an ink', () => {
  const { sample } = JSON.parse(readFileSync(new URL('./open-alex-works.fixture.json', import.meta.url), 'utf8')) as { sample: OpenAlexWork[] };
  const unmapped = sample.filter(work => String(work.primary_topic?.field?.id).split('/').pop() === '33');
  assert.equal(unmapped.length, 2);
  for (const work of unmapped) {
    const paper = PaperBuilder.deduplicate([new OpenAlexAdapter().mapToStandard(work)])[0];
    assert.equal(areaKeyForPaper(paper), null, work.id);
    assert.equal(areaLabelForPaper(paper), work.primary_topic?.field?.display_name, work.id);
    assert.equal(areaAccentForPaper(paper), 'var(--gradient-brand)', work.id);
  }
});

test('a work OpenAlex files under Chemistry reads as Chemistry, with its ink', () => {
  const { sample } = JSON.parse(readFileSync(new URL('./open-alex-works.fixture.json', import.meta.url), 'utf8')) as { sample: OpenAlexWork[] };
  const chemistry = sample.filter(work => String(work.primary_topic?.field?.id).split('/').pop() === '16');
  assert.equal(chemistry.length, 2);
  for (const work of chemistry) {
    const paper = PaperBuilder.deduplicate([new OpenAlexAdapter().mapToStandard(work)])[0];
    assert.equal(areaKeyForPaper(paper), 'chem', work.id);
    assert.equal(areaLabelForPaper(paper), 'Chemistry', work.id);
    assert.equal(areaAccentForPaper(paper), 'var(--gradient-chem)', work.id);
  }
  assert.equal(openAlexFilterForArea('chem'), 'primary_topic.field.id:16');
});

test('an arXiv category still wins over the topic name', () => {
  const paper = { primaryCategory: 'math.AG', categories: ['Protein Structure and Dynamics'] };
  assert.equal(areaKeyForPaper(paper), 'math');
});

test('a branch that cannot be worked out resolves to nothing, not to physics', () => {
  for (const paper of [{}, { categories: [] }, { categories: ['General'] }, { primaryCategory: 'Miscellaneous' }]) {
    assert.equal(areaKeyForPaper(paper), null, JSON.stringify(paper));
  }
  // And the ink says so too, rather than picking a field at random.
  assert.equal(areaAccentForPaper({ categories: ['General'] }), 'var(--gradient-brand)');
});

test('the ink and the label come from the same resolution', () => {
  const paper = { primaryTopic: { id: 'https://openalex.org/T10889', subfield: { id: 'https://openalex.org/subfields/2212', display_name: 'Ocean Engineering' }, field: { id: 'https://openalex.org/fields/22', display_name: 'Engineering' } } };
  assert.equal(areaKeyForPaper(paper), 'civil');
  assert.equal(areaAccentForPaper(paper), 'var(--gradient-civil)');
  assert.equal(areaLabelForPaper(paper), 'Civil & Environmental Engineering');
});
