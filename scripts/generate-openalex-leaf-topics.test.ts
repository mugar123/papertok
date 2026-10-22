import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getAllLeafCategories } from '../src/data/categoryTaxonomy.ts';

// Synthetic catalogue and article samples; these do not establish live precision.
const catalogue = [
  { id: 'T19001', display_name: 'Artificial Intelligence Planning', keywords: ['Artificial Intelligence'], field: { id: '17' } },
  { id: 'T19002', display_name: 'Cosmology', keywords: ['Cosmology'], field: { id: '31' } },
  { id: 'T19003', display_name: 'Economic Theory', keywords: ['Economics'], field: { id: '20' } },
  { id: 'T19004', display_name: 'Artificial Intelligence in Medicine', keywords: ['Artificial Intelligence'], field: { id: '27' } },
];

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
  writeFileSync(input, JSON.stringify(catalogue));
  writeFileSync(reviews, '{}');
  const run = (...extra: string[]) => spawnSync(process.execPath, [
    'scripts/generate-openalex-leaf-topics.ts', '--catalogue', input,
    '--reviews', reviews, '--out', output, '--report', report, ...extra,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const coverage = () => JSON.parse(readFileSync(report, 'utf8')) as Array<{
    leaf: string; status: string; topicIds: string[]; candidateHash: string; sampleSize?: number; precision?: number;
  }>;
  return { directory, reviews, output, run, coverage };
}

function evidence(topic: string, candidateHash: string, relevant = 12) {
  const works = Array.from({ length: 15 }, (_, index) => ({
    id: `https://openalex.org/W99000${index}`, type: 'article',
    title: `Synthetic scientific result ${index}`, publication_date: '2026-10-20',
    abstract_inverted_index: { Synthetic: [0], abstract: [1] } as Record<string, number[]>,
    primary_topic: { id: `https://openalex.org/${topic}` },
  }));
  const query = new URL('https://api.openalex.org/works');
  query.searchParams.set('filter', `primary_topic.id:${topic},type:article,from_publication_date:2026-07-24,to_publication_date:2026-10-22,has_abstract:true,is_retracted:false,primary_location.source.is_core:true`);
  query.searchParams.set('sort', 'publication_date:desc');
  query.searchParams.set('per-page', '25');
  query.searchParams.set('page', '1');
  query.searchParams.set('mailto', 'app@papertok.io');
  return {
    candidateHash, capturedAt: '2026-10-22T12:00:00Z', query: query.href, works,
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
    return [leaf, evidence(row.topicIds[0], row.candidateHash)];
  }))));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(coverage().filter(row => row.status === 'passed').length, 3);
  for (const leaf of ['cs.AI', 'astro-ph.CO', 'econ.GN']) {
    assert.ok(readFileSync(output, 'utf8').includes(`'${leaf}':`));
  }
});

test('low precision or too few papers cannot enable a leaf', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  const { topicIds, candidateHash } = coverage().find(row => row.leaf === 'cs.AI')!;
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': evidence(topicIds[0], candidateHash, 9) }));
  assert.equal(run().status, 0);
  assert.equal(coverage().find(row => row.leaf === 'cs.AI')!.status, 'rejected');
  assert.ok(!readFileSync(output, 'utf8').includes("'cs.AI':"));
  const short = evidence(topicIds[0], candidateHash);
  short.works = short.works.slice(0, 5);
  short.labels = short.labels.slice(0, 5);
  writeFileSync(reviews, JSON.stringify({ 'cs.AI': short }));
  assert.equal(run().status, 0);
  assert.equal(coverage().find(row => row.leaf === 'cs.AI')!.status, 'insufficient-sample');
  assert.ok(!readFileSync(output, 'utf8').includes("'cs.AI':"));
});

test('stale candidates, duplicate labels and non-feed samples fail without overwriting output', t => {
  const { run, reviews, output, coverage } = setup(t);
  assert.equal(run().status, 0);
  const before = readFileSync(output, 'utf8');
  const { topicIds, candidateHash } = coverage().find(row => row.leaf === 'cs.AI')!;
  for (const change of ['hash', 'duplicate-label', 'missing-label', 'text-query', 'old-paper', 'missing-abstract', 'wrong-topic']) {
    const review = evidence(topicIds[0], candidateHash);
    if (change === 'hash') review.candidateHash = 'stale';
    if (change === 'duplicate-label') review.labels[1] = review.labels[0];
    if (change === 'missing-label') review.labels.pop();
    if (change === 'text-query') review.query = 'https://api.openalex.org/works?search=Artificial+Intelligence';
    if (change === 'old-paper') review.works[0].publication_date = '2001-01-01';
    if (change === 'missing-abstract') review.works[0].abstract_inverted_index = {};
    if (change === 'wrong-topic') review.works[0].primary_topic.id = 'https://openalex.org/T99999';
    writeFileSync(reviews, JSON.stringify({ 'cs.AI': review }));
    const result = run();
    assert.notEqual(result.status, 0, `${change} must fail`);
    assert.equal(readFileSync(output, 'utf8'), before, `${change} preserves the previous map`);
  }
});

test('--check detects a stale generated file', t => {
  const { run, output } = setup(t);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(output, '// stale output\n');
  assert.notEqual(run('--check').status, 0);
  assert.equal(readFileSync(output, 'utf8'), '// stale output\n');
});

test('generation can reconstruct a missing output from taxonomy inputs', t => {
  const { directory } = setup(t);
  const checkout = join(directory, 'checkout');
  mkdirSync(checkout);
  cpSync(new URL('./', import.meta.url), join(checkout, 'scripts'), { recursive: true });
  cpSync(new URL('../src/', import.meta.url), join(checkout, 'src'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{"type":"module"}\n');
  const output = join(checkout, 'src/data/openAlexLeafTopics.generated.ts');
  rmSync(output);
  const result = spawnSync(process.execPath, ['scripts/generate-openalex-leaf-topics.ts'], {
    cwd: checkout, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /'bio\.mol': \['T10878', 'T10521', 'T10604'/);
});
