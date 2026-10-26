import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';

// Synthetic catalogue and article samples; these do not establish live precision.
const catalogue = [
  { id: 'T19001', display_name: 'Artificial Intelligence Planning', keywords: ['Artificial Intelligence'], field: { id: '17' }, subfield: { id: '1702' } },
  { id: 'T19002', display_name: 'Cosmology', keywords: ['Cosmology'], field: { id: '31' } },
  { id: 'T19003', display_name: 'Economic Theory', keywords: ['Economics'], field: { id: '20' } },
  { id: 'T19004', display_name: 'Artificial Intelligence in Medicine', keywords: ['Artificial Intelligence'], field: { id: '27' } },
  // Two subfields for the notable candidates: cardiology (two topics) and surgery (one).
  { id: 'T19006', display_name: 'Heart Failure Treatment', keywords: [], field: { id: '27' }, subfield: { id: '2705' } },
  { id: 'T19007', display_name: 'Atrial Fibrillation Management', keywords: [], field: { id: '27' }, subfield: { id: '2705' } },
  { id: 'T19008', display_name: 'Hernia Repair', keywords: [], field: { id: '27' }, subfield: { id: '2746' } },
];
// The notable subfields map for the synthetic catalogue: a leaf with two
// subfields' topics and a topic filed elsewhere, one with nothing fitting.
const subfields = { 'med.cardio': ['2705'], 'med.surg': ['2746', 'T19001'], 'cs.MM': [] };

test('the checked-in map is reproducible from the default inputs', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-openalex-leaf-topics.ts', '--check'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

function setup(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pap92-generation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, 'catalogue.json');
  const reviews = join(directory, 'reviews.json');
  const output = join(directory, 'topics.ts');
  const report = join(directory, 'coverage.json');
  const subfieldsFile = join(directory, 'subfields.json');
  const notableReviews = join(directory, 'notable-reviews.json');
  const notableOutput = join(directory, 'notable-topics.ts');
  const candidatesFile = join(directory, 'candidates.json');
  writeFileSync(input, JSON.stringify(catalogue));
  writeFileSync(reviews, '{}');
  writeFileSync(subfieldsFile, JSON.stringify(subfields));
  writeFileSync(notableReviews, '{}');
  const run = (...extra: string[]) => spawnSync(process.execPath, [
    'scripts/generate-openalex-leaf-topics.ts', '--catalogue', input,
    '--reviews', reviews, '--out', output, '--report', report,
    '--subfields', subfieldsFile, '--notable-reviews', notableReviews, '--notable-out', notableOutput, '--candidates', candidatesFile, ...extra,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const coverage = () => JSON.parse(readFileSync(report, 'utf8')) as Array<{
    leaf: string; status: string; topicIds: string[]; sampleSize?: number; precision?: number; byTopic?: Record<string, string>;
  }>;
  const candidates = () => JSON.parse(readFileSync(candidatesFile, 'utf8')) as { year: number; leaves: Array<{
    leaf: string; label: string; subfields: string[]; status: string; topicIds: string[]; sampleUrl?: string;
    sampleSize?: number; onTarget?: number; precision?: number; byTopic?: Record<string, string>;
  }> };
  return { directory, input, reviews, output, report, subfieldsFile, notableReviews, notableOutput, candidatesFile, run, coverage, candidates };
}

// The leaves with a topic lane in every run of the synthetic setup: the inherited lists.
const inherited = Object.keys((JSON.parse(readFileSync(new URL('./data/openalex-leaf-topics-baseline.json', import.meta.url), 'utf8')) as { topics: object }).topics);

// A notable sample: the 15 most cited articles of 2016–2025 on `topics`, which
// OpenAlex returns most cited first; `relevant` of them labelled on target.
function notableEvidence(topics: string[], relevant = 12, year = 2026) {
  const works = Array.from({ length: 15 }, (_, index) => ({
    id: `https://openalex.org/W98000${index}`, type: 'article',
    title: `Much-cited synthetic result ${index}`, publication_date: `${year - 10 + (index % 10)}-06-01`,
    cited_by_count: 5000 - index * 100,
    primary_topic: { id: `https://openalex.org/${topics[index % topics.length]}` },
  }));
  const query = new URL('https://api.openalex.org/works');
  query.searchParams.set('filter', `primary_topic.id:${[...topics].sort().join('|')},type:article,from_publication_date:${year - 10}-01-01,to_publication_date:${year - 1}-12-31,has_abstract:true,is_retracted:false,primary_location.source.is_core:true`);
  query.searchParams.set('sort', 'cited_by_count:desc');
  query.searchParams.set('page', '1');
  query.searchParams.set('per-page', '15');
  return {
    capturedAt: `${year}-10-26T09:00:00Z`, query: query.href, works,
    labels: works.map((work, index) => ({ workId: work.id, label: index < relevant ? 'on-target' : 'off-target' })),
  };
}

test("a notable lane's candidates are the catalogue topics of the leaf's subfields, with a most-cited sample query", t => {
  const { run, candidates, notableOutput } = setup(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const { year, leaves: rows } = candidates();
  assert.equal(year, new Date().getUTCFullYear());
  assert.deepEqual(rows.map(row => row.leaf), getAllLeafCategories().map(leaf => leaf.id).filter(leaf => !inherited.includes(leaf)),
    'one row per leaf without a topic lane, in taxonomy order');
  const cardio = rows.find(row => row.leaf === 'med.cardio')!;
  assert.deepEqual([cardio.status, cardio.subfields, cardio.topicIds], ['not-reviewed', ['2705'], ['T19006', 'T19007']]);
  const url = new URL(cardio.sampleUrl!);
  assert.deepEqual(url.searchParams.get('filter')!.split(','), [
    'primary_topic.id:T19006|T19007', 'type:article',
    `from_publication_date:${year - 10}-01-01`, `to_publication_date:${year - 1}-12-31`,
    'has_abstract:true', 'is_retracted:false', 'primary_location.source.is_core:true',
  ]);
  assert.deepEqual([url.searchParams.get('sort'), url.searchParams.get('page'), url.searchParams.get('per-page')], ['cited_by_count:desc', '1', '15']);
  assert.ok(url.searchParams.get('select')!.split(',').includes('cited_by_count'), 'the sample records the citation order');
  assert.deepEqual(rows.find(row => row.leaf === 'med.surg')!.topicIds, ['T19001', 'T19008'], 'a topic named by ID joins its subfield\'s');
  const multimedia = rows.find(row => row.leaf === 'cs.MM')!;
  assert.deepEqual([multimedia.status, multimedia.topicIds, multimedia.sampleUrl], ['no-candidates', [], undefined]);
  assert.equal(rows.find(row => row.leaf === 'quant-ph')!.status, 'not-mapped', 'a leaf the map leaves out is reported, not proposed');
  assert.ok(!rows.some(row => row.leaf === 'bio.mol'), 'a leaf with a topic lane lists its topics; it needs no notable candidates');
  assert.equal(readFileSync(notableOutput, 'utf8'), [
    '// Generated by scripts/generate-openalex-leaf-topics.ts; do not edit.',
    'export const OPENALEX_NOTABLE_LEAF_TOPICS: Readonly<Record<string, readonly string[]>> = Object.freeze({', '});', '',
  ].join('\n'), 'no leaf enters the notable map without a passing sample');
});

test('a passing notable sample admits the leaf to the notable map only, asking for the topics found on target', t => {
  const { run, notableReviews, notableOutput, output, candidates } = setup(t);
  // 12 on target: T19006 holds 8 of them and T19007 4; three off target on T19007.
  const review = notableEvidence(['T19006', 'T19007']);
  for (const [index, label] of review.labels.entries()) label.label = index % 2 === 0 || index < 8 ? 'on-target' : 'off-target';
  writeFileSync(notableReviews, JSON.stringify({ 'med.cardio': review }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const row = candidates().leaves.find(row => row.leaf === 'med.cardio')!;
  assert.equal(row.status, 'passed');
  assert.equal(row.sampleUrl, undefined, 'a reviewed leaf keeps its sample, not a new proposal');
  assert.match(readFileSync(notableOutput, 'utf8'), /'med\.cardio': \['T19006', 'T19007'\],/);
  assert.ok(!readFileSync(output, 'utf8').includes("'med.cardio':"), 'no topic lane');
  // Only topics with an article on target enter the lane.
  const partial = notableEvidence(['T19006', 'T19007']);
  for (const work of partial.works.slice(12)) work.primary_topic.id = 'https://openalex.org/T19007';
  for (const work of partial.works.slice(0, 12)) work.primary_topic.id = 'https://openalex.org/T19006';
  writeFileSync(notableReviews, JSON.stringify({ 'med.cardio': partial }));
  assert.equal(run().status, 0);
  assert.match(readFileSync(notableOutput, 'utf8'), /'med\.cardio': \['T19006'\],/);
  assert.deepEqual(candidates().leaves.find(row => row.leaf === 'med.cardio')!.byTopic, { T19006: '12/12', T19007: '0/3' });
});

test('a notable sample must be the most-cited page of the ten completed years, labelled in full', t => {
  const { run, notableReviews, notableOutput, candidates } = setup(t);
  assert.equal(run().status, 0);
  const before = readFileSync(notableOutput, 'utf8');
  const cases: Record<string, (review: ReturnType<typeof notableEvidence>) => void> = {
    'newest-first sort': review => { review.query = review.query.replace('cited_by_count%3Adesc', 'publication_date%3Adesc'); },
    'current year': review => { review.works[0].publication_date = '2026-03-01'; },
    'eleven years back': review => { review.works[0].publication_date = '2015-12-31'; },
    'out of citation order': review => { review.works[3].cited_by_count = 9999; },
    'no citation count': review => { delete (review.works[0] as { cited_by_count?: number }).cited_by_count; },
    'missing label': review => { review.labels.pop(); },
    'topic-lane leaf': review => { writeFileSync(notableReviews, JSON.stringify({ 'bio.mol': review })); },
  };
  for (const [name, change] of Object.entries(cases)) {
    const review = notableEvidence(['T19006', 'T19007']);
    writeFileSync(notableReviews, JSON.stringify({ 'med.cardio': review }));
    change(review);
    if (name !== 'topic-lane leaf') writeFileSync(notableReviews, JSON.stringify({ 'med.cardio': review }));
    assert.notEqual(run().status, 0, `${name} must fail`);
    assert.equal(readFileSync(notableOutput, 'utf8'), before, `${name} preserves the previous map`);
  }
  writeFileSync(notableReviews, JSON.stringify({ 'med.cardio': notableEvidence(['T19006', 'T19007'], 9) }));
  assert.equal(run().status, 0);
  assert.deepEqual(candidates().leaves.find(row => row.leaf === 'med.cardio')!.status, 'rejected');
  assert.equal(readFileSync(notableOutput, 'utf8'), before);
});

test('the notable subfields map names only leaves without a topic lane, and a proposal stays within what one OpenAlex filter takes', t => {
  const { run, input, subfieldsFile, reviews, candidates, notableOutput } = setup(t);
  const before = () => existsSync(notableOutput) && readFileSync(notableOutput, 'utf8');
  writeFileSync(subfieldsFile, JSON.stringify({ ...subfields, 'bio.mol': ['2705'] }));
  assert.notEqual(run().status, 0, 'an inherited leaf has a topic lane');
  writeFileSync(subfieldsFile, JSON.stringify({ ...subfields, 'nlin.CD': ['2705'] }));
  assert.notEqual(run().status, 0, 'not a taxonomy leaf');
  writeFileSync(subfieldsFile, JSON.stringify({ ...subfields, 'quant-ph': ['9999'] }));
  assert.notEqual(run().status, 0, 'a subfield the catalogue has no topic in');
  writeFileSync(subfieldsFile, JSON.stringify(subfields));
  assert.equal(run().status, 0);
  const map = before();
  // Once cs.AI passes its topic review, its notable lane lists those topics; a notable entry for it is stale.
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': evidence('T19001') }));
  writeFileSync(subfieldsFile, JSON.stringify({ ...subfields, 'cs.AI': ['1702'] }));
  assert.notEqual(run().status, 0, 'a leaf admitted to topic lanes leaves the notable map');
  assert.equal(before(), map);
  writeFileSync(reviews, '{}');
  // A subfield of 101 topics cannot be asked in one query.
  const wide = Array.from({ length: 101 }, (_, index) => ({ id: `T2${String(index).padStart(4, '0')}`, display_name: `Wide topic ${index}`, keywords: [], subfield: { id: '2999' } }));
  writeFileSync(input, JSON.stringify([...catalogue, ...wide]));
  writeFileSync(subfieldsFile, JSON.stringify({ ...subfields, 'quant-ph': ['2999'] }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const row = candidates().leaves.find(row => row.leaf === 'quant-ph')!;
  assert.deepEqual([row.status, row.topicIds.length, row.sampleUrl], ['too-many-candidates', 101, undefined]);
});

function evidence(topic: string, relevant = 12) {
  const works = Array.from({ length: 15 }, (_, index) => ({
    id: `https://openalex.org/W99000${index}`, type: 'article',
    title: `Synthetic scientific result ${index}`, publication_date: '2026-10-20',
    abstract_inverted_index: { Synthetic: [0], abstract: [1] } as Record<string, number[]>,
    primary_topic: { id: `https://openalex.org/${topic}` },
  }));
  const query = new URL('https://api.openalex.org/works');
  query.searchParams.set('filter', `primary_topic.id:${topic},type:article,from_publication_date:2026-07-24,to_publication_date:2026-10-22,has_abstract:true,is_retracted:false,primary_location.source.is_core:true`);
  query.searchParams.set('sort', 'publication_date:desc');
  query.searchParams.set('per-page', '15');
  query.searchParams.set('page', '1');
  query.searchParams.set('mailto', 'app@papertok.io');
  return {
    capturedAt: '2026-10-22T12:00:00Z', query: query.href, works,
    labels: works.map((work, index) => ({ workId: work.id, label: index < relevant ? 'on-target' : 'off-target' })),
  };
}

test('generation proposes every taxonomy leaf but enables none without evidence', t => {
  const { run, output, coverage } = setup(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = coverage();
  assert.deepEqual(report.map(row => row.leaf).sort(), getAllLeafCategories().map(leaf => leaf.id).sort());
  assert.equal(report.filter(row => row.status === 'inherited').length, 14);
  for (const leaf of ['cs.AI', 'astro-ph.CO', 'econ.GN']) {
    const candidate = report.find(row => row.leaf === leaf)!;
    assert.ok(candidate.topicIds.length > 0, `${leaf} has generated candidates`);
    assert.equal(candidate.status, 'not-reviewed');
    assert.ok(!readFileSync(output, 'utf8').includes(`'${leaf}':`), `${leaf} is not active`);
  }
  assert.deepEqual(report.find(row => row.leaf === 'cs.AI')!.topicIds, ['T19001'], 'another field is excluded before review');
  assert.match(readFileSync(output, 'utf8'), /'bio\.mol': \['T10878', 'T10521', 'T10604'/,
    'an inherited leaf retains its checked topic order');
});

test('complete recent labels enable generated AI, cosmology and economics candidates', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  const rows = coverage();
  writeFileSync(reviews, JSON.stringify(Object.fromEntries(['cs.AI', 'astro-ph.CO', 'econ.GN'].map(leaf => {
    const row = rows.find(row => row.leaf === leaf)!;
    return [leaf, evidence(row.topicIds[0])];
  }))));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(coverage().filter(row => row.status === 'passed').length, 3);
  for (const leaf of ['cs.AI', 'astro-ph.CO', 'econ.GN']) {
    assert.ok(readFileSync(output, 'utf8').includes(`'${leaf}':`));
  }
});

test('a review records only what the gate checks: no abstracts, no sampler address', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  const { topicIds } = coverage().find(row => row.leaf === 'cs.AI')!;
  const review = evidence(topicIds[0]);
  const query = new URL(review.query);
  query.searchParams.delete('mailto');
  // The query's has_abstract:true is the evidence that every work had one.
  const works = review.works.map(({ id, type, title, publication_date, primary_topic }) => ({ id, type, title, publication_date, primary_topic }));
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': { ...review, query: query.href, works } }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(coverage().find(row => row.leaf === 'cs.AI'), {
    leaf: 'cs.AI', label: 'Artificial Intelligence', topicIds,
    status: 'passed', sampleSize: 15, onTarget: 12, precision: 0.8, byTopic: { [topicIds[0]]: '12/15' },
  });
  assert.ok(readFileSync(output, 'utf8').includes("'cs.AI':"));
});

test('low precision or too few papers cannot enable a leaf', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  const { topicIds } = coverage().find(row => row.leaf === 'cs.AI')!;
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': evidence(topicIds[0], 9) }));
  assert.equal(run().status, 0);
  assert.equal(coverage().find(row => row.leaf === 'cs.AI')!.status, 'rejected');
  assert.ok(!readFileSync(output, 'utf8').includes("'cs.AI':"));
  const short = evidence(topicIds[0]);
  short.works = short.works.slice(0, 5);
  short.labels = short.labels.slice(0, 5);
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': short }));
  assert.equal(run().status, 0);
  assert.equal(coverage().find(row => row.leaf === 'cs.AI')!.status, 'insufficient-sample');
  assert.ok(!readFileSync(output, 'utf8').includes("'cs.AI':"));
});

test('a passing leaf asks only for the topics its sample found on target', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  // 12 articles on T19001, all on target; 3 on T19005, all off target; none on T19006.
  const review = evidence('T19001');
  review.query = review.query.replace('primary_topic.id%3AT19001', 'primary_topic.id%3AT19001%7CT19005%7CT19006');
  for (const work of review.works.slice(12)) work.primary_topic.id = 'https://openalex.org/T19005';
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': review }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /'cs\.AI': \['T19001'\],/);
  const row = coverage().find(row => row.leaf === 'cs.AI')!;
  assert.deepEqual([row.status, row.topicIds, row.byTopic], ['passed', ['T19001', 'T19005', 'T19006'], { T19001: '12/12', T19005: '0/3', T19006: '0/0' }]);
});

test('a call the labeller marked uncertain counts as a miss', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  const { topicIds } = coverage().find(row => row.leaf === 'cs.AI')!;
  // 12 of 15 labelled on target, 3 of them doubted: 9 of 15 is under two thirds.
  const review = evidence(topicIds[0]);
  for (const label of review.labels.slice(0, 3)) Object.assign(label, { uncertain: true });
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': review }));
  assert.equal(run().status, 0);
  const row = coverage().find(row => row.leaf === 'cs.AI')!;
  assert.deepEqual([row.status, row.sampleSize, row.precision], ['rejected', 15, 9 / 15]);
  assert.ok(!readFileSync(output, 'utf8').includes("'cs.AI':"));
  Object.assign(review.labels[0], { uncertain: 'maybe' });
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': review }));
  assert.notEqual(run().status, 0, 'a doubt is recorded as true or not at all');
});

test('a doubted call can leave out the label when the labeller leaned neither way', t => {
  const { run, reviews, coverage } = setup(t);
  assert.equal(run().status, 0);
  const { topicIds } = coverage().find(row => row.leaf === 'cs.AI')!;
  // 12 of 15 on target, then two of them recorded as doubt with no lean: 10 of 15.
  const review = evidence(topicIds[0]);
  const labels = (doubted: object) => review.labels.map((label, index) => index < 10 || index > 11 ? label : { workId: label.workId, ...doubted });
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': { ...review, labels: labels({ uncertain: true }) } }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const row = coverage().find(row => row.leaf === 'cs.AI')!;
  assert.deepEqual([row.status, row.precision, row.byTopic], ['passed', 10 / 15, { [topicIds[0]]: '10/15' }]);
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': { ...review, labels: labels({}) } }));
  assert.notEqual(run().status, 0, 'a call without doubt names its label');
});

test('unsorted topics, duplicate labels and non-feed samples fail without overwriting output', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  const before = readFileSync(output, 'utf8');
  const { topicIds } = coverage().find(row => row.leaf === 'cs.AI')!;
  for (const change of ['unsorted-topics', 'duplicate-label', 'missing-label', 'text-query', 'long-page', 'old-paper', 'no-abstract-filter', 'wrong-topic']) {
    const review = evidence(topicIds[0]);
    if (change === 'unsorted-topics') review.query = review.query.replace(`primary_topic.id%3A${topicIds[0]}`, `primary_topic.id%3AT99999%7C${topicIds[0]}`);
    if (change === 'duplicate-label') review.labels[1] = review.labels[0];
    if (change === 'missing-label') review.labels.pop();
    if (change === 'text-query') review.query = 'https://api.openalex.org/works?search=Artificial+Intelligence';
    if (change === 'long-page') review.query = review.query.replace('per-page=15', 'per-page=25');
    if (change === 'old-paper') review.works[0].publication_date = '2001-01-01';
    if (change === 'no-abstract-filter') review.query = review.query.replace('%2Chas_abstract%3Atrue', '');
    if (change === 'wrong-topic') review.works[0].primary_topic.id = 'https://openalex.org/T99999';
    writeFileSync(reviews, JSON.stringify({ 'cs.AI': review }));
    const result = run();
    assert.notEqual(result.status, 0, `${change} must fail`);
    assert.equal(readFileSync(output, 'utf8'), before, `${change} preserves the previous map`);
  }
});

test('--check detects a stale generated map, coverage report, notable map or candidates file', t => {
  const { run, output, report, notableOutput, candidatesFile } = setup(t);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(output, '// stale output\n');
  assert.notEqual(run('--check').status, 0);
  assert.equal(readFileSync(output, 'utf8'), '// stale output\n');
  assert.equal(run().status, 0);
  writeFileSync(report, '[]\n');
  assert.notEqual(run('--check').status, 0, 'a stale coverage report fails the check');
  assert.equal(readFileSync(report, 'utf8'), '[]\n');
  assert.equal(run().status, 0);
  writeFileSync(notableOutput, '// stale output\n');
  assert.notEqual(run('--check').status, 0, 'a stale notable map fails the check');
  assert.equal(run().status, 0);
  const candidates = JSON.parse(readFileSync(candidatesFile, 'utf8')) as { year: number; leaves: unknown[] };
  writeFileSync(candidatesFile, JSON.stringify({ ...candidates, leaves: [] }));
  assert.notEqual(run('--check').status, 0, 'a stale candidates file fails the check');
  // The proposals' window is the one the file recorded, until the next generation moves it:
  // a file written last year, its year and every window a year back, still checks.
  assert.equal(run().status, 0);
  const lastYear = readFileSync(candidatesFile, 'utf8')
    .replace(`"year": ${candidates.year}`, `"year": ${candidates.year - 1}`)
    .replaceAll(`from_publication_date%3A${candidates.year - 10}-01-01`, `from_publication_date%3A${candidates.year - 11}-01-01`)
    .replaceAll(`to_publication_date%3A${candidates.year - 1}-12-31`, `to_publication_date%3A${candidates.year - 2}-12-31`);
  assert.notEqual(lastYear, readFileSync(candidatesFile, 'utf8'));
  writeFileSync(candidatesFile, lastYear);
  assert.equal(run('--check').status, 0, 'the recorded year is kept by --check');
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(readFileSync(candidatesFile, 'utf8')).year, candidates.year, 'generation moves the window to the current year');
});

function copyCheckout(t: import('node:test').TestContext) {
  const { directory } = setup(t);
  const checkout = join(directory, 'checkout');
  mkdirSync(checkout);
  cpSync(new URL('./', import.meta.url), join(checkout, 'scripts'), { recursive: true });
  cpSync(new URL('../src/', import.meta.url), join(checkout, 'src'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{"type":"module"}\n');
  const generate = () => spawnSync(process.execPath, ['scripts/generate-openalex-leaf-topics.ts'], { cwd: checkout, encoding: 'utf8' });
  return { checkout, generate };
}

test('generation can reconstruct a missing output from taxonomy inputs', t => {
  const { checkout, generate } = copyCheckout(t);
  const output = join(checkout, 'src/data/open-alex-leaf-topics.generated.ts');
  rmSync(output);
  const result = generate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /'bio\.mol': \['T10878', 'T10521', 'T10604'/);
});

test("renaming a reviewed leaf keeps its review: its topics are the ones the sample's query named", t => {
  const { checkout, generate } = copyCheckout(t);
  const taxonomy = join(checkout, 'src/data/category-taxonomy.ts');
  const output = join(checkout, 'src/data/open-alex-leaf-topics.generated.ts');
  const report = join(checkout, 'scripts/data/openalex-leaf-topics-coverage.json');
  const rowOf = (leaf: string) => (JSON.parse(readFileSync(report, 'utf8')) as Array<{ leaf: string }>).find(row => row.leaf === leaf)!;
  const map = readFileSync(output, 'utf8');
  const reviewed = rowOf('cs.CV');
  // A copy edit that changes which catalogue topics the label proposes.
  writeFileSync(taxonomy, readFileSync(taxonomy, 'utf8').replace("'cs.CV': { label: 'Computer Vision' }", "'cs.CV': { label: 'Vision' }"));
  const result = generate();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), map, 'the map keeps the reviewed topics');
  assert.deepEqual(rowOf('cs.CV'), { ...reviewed, label: 'Vision' });
});
