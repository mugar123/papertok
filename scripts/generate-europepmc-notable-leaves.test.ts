import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Synthetic samples; these do not establish live precision.
interface Options {
  label?: string; onTarget?: number; size?: number; uncertain?: number; capturedAt?: string;
  years?: string; sort?: string; abstract?: boolean; params?: Record<string, string>; hitCount?: number;
}

// The 15 most-cited records of a label over the ten completed years before
// the capture, citations falling from 9,000, the first `onTarget` on target
// and the next `uncertain` doubted.
function sample({ label = 'Genetics', onTarget = 12, size = 15, uncertain = 0, capturedAt = '2026-10-26T12:00:00Z', years = '2016 TO 2025', sort = 'sort_cited:y', abstract = true, params = {}, hitCount = 5000 }: Options = {}) {
  const query = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
  query.searchParams.set('query', `(TITLE_ABS:"${label}" OR KW:"${label}") AND PUB_YEAR:[${years}]${abstract ? ' AND HAS_ABSTRACT:y' : ''} ${sort}`);
  query.searchParams.set('format', 'json');
  query.searchParams.set('resultType', 'core');
  query.searchParams.set('pageSize', '15');
  query.searchParams.set('page', '1');
  for (const [name, value] of Object.entries(params)) query.searchParams.set(name, value);
  const works = Array.from({ length: size }, (_, index) => ({
    id: `3${String(index).padStart(7, '0')}`, source: index === 3 ? 'PPR' : 'MED', title: `A synthetic landmark of the field, number ${index}`,
    pubYear: String(2016 + (index % 10)), citedByCount: 9000 - index * 10,
  }));
  const labels = works.map((work, index) => (index < onTarget
    ? { workId: work.id, label: 'on-target' }
    : index < onTarget + uncertain ? { workId: work.id, uncertain: true } : { workId: work.id, label: 'off-target' }));
  return { capturedAt, query: query.href, hitCount, works, labels };
}

function setup(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'europepmc-notable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reviews = join(directory, 'reviews.json');
  const output = join(directory, 'leaves.ts');
  const report = join(directory, 'coverage.json');
  const write = (leaves: Record<string, unknown>) => writeFileSync(reviews, JSON.stringify({ leaves }));
  const run = (...extra: string[]) => spawnSync(process.execPath, [
    'scripts/generate-europepmc-notable-leaves.ts', '--reviews', reviews, '--out', output, '--report', report, ...extra,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const coverage = () => JSON.parse(readFileSync(report, 'utf8')) as Array<{ leaf: string; status: string; sampleSize: number; onTarget: number }>;
  const admitted = () => [...readFileSync(output, 'utf8').matchAll(/^ {2}'([^']+)',$/gm)].map(match => match[1]);
  return { write, run, coverage, admitted, output };
}

test('the checked-in Europe PMC notable leaves are reproducible from the default inputs', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-europepmc-notable-leaves.ts', '--check'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a leaf passes with 10 of 15 on target without doubt, and not with 9, with doubted calls or with a short page', t => {
  const { write, run, coverage, admitted } = setup(t);
  write({
    'bio.gen': sample({ onTarget: 10 }),
    'bio.mol': sample({ label: 'Molecular Biology', onTarget: 9 }),
    // 12 on target, three of them doubted: 9 count.
    'med.onco': sample({ label: 'Oncology', onTarget: 9, uncertain: 3 }),
    'med.cardio': sample({ label: 'Cardiology', size: 14, onTarget: 14 }),
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(coverage().map(row => [row.leaf, row.status, row.onTarget, row.sampleSize]), [
    ['bio.gen', 'passed', 10, 15],
    ['bio.mol', 'rejected', 9, 15],
    ['med.cardio', 'insufficient-sample', 14, 14],
    ['med.onco', 'rejected', 9, 15],
  ]);
  assert.deepEqual(admitted(), ['bio.gen']);
});

test("a sample must be the leaf's own query over the ten completed years before its capture, most cited first", t => {
  const { write, run, admitted } = setup(t);
  write({ 'bio.gen': sample() });
  assert.equal(run().status, 0);
  const broken = [
    sample({ label: 'Molecular Biology' }),
    sample({ years: '2015 TO 2024' }),
    sample({ capturedAt: '2027-01-02T12:00:00Z' }),
    sample({ sort: 'sort_date:y' }),
    sample({ abstract: false }),
    sample({ params: { pageSize: '25' } }),
    sample({ params: { synonym: 'true' } }),
  ];
  for (const value of broken) {
    write({ 'bio.gen': value });
    assert.notEqual(run().status, 0, value.query);
    assert.deepEqual(admitted(), ['bio.gen'], 'a refused input leaves the output as it was');
  }
});

test('a leaf whose label matches fewer records than its listing takes is not admitted, however precise its sample', t => {
  const { write, run, coverage, admitted } = setup(t);
  write({ 'bio.gen': sample({ onTarget: 15, hitCount: 999 }), 'bio.mol': sample({ label: 'Molecular Biology', hitCount: 1000 }) });
  assert.equal(run().status, 0);
  assert.deepEqual(coverage().map(row => [row.leaf, row.status]), [['bio.gen', 'small-population'], ['bio.mol', 'passed']]);
  assert.deepEqual(admitted(), ['bio.mol']);
});

test('a record listed twice, as two journals publish one guideline, counts once, on target only if both copies are', t => {
  const { write, run, coverage } = setup(t);
  const twice = sample({ onTarget: 11 });
  twice.works[1] = { ...twice.works[1], title: `${twice.works[0].title.toUpperCase()}.` };
  twice.labels[1] = { workId: twice.works[1].id, label: 'off-target' };
  write({ 'bio.gen': twice });
  assert.equal(run().status, 0);
  assert.deepEqual(coverage().map(row => [row.status, row.onTarget, row.sampleSize]), [['insufficient-sample', 9, 14]]);
});

test('records whose title is too short to name one paper are not joined, as the store does not join them', t => {
  const { write, run, coverage } = setup(t);
  const annual = sample();
  for (const index of [0, 1, 2]) annual.works[index] = { ...annual.works[index], title: 'Marine natural products.' };
  write({ 'bio.gen': annual });
  assert.equal(run().status, 0);
  assert.deepEqual(coverage().map(row => [row.status, row.sampleSize]), [['passed', 15]]);
});

test('only a medicine or biology leaf of the taxonomy takes a Europe PMC sample', t => {
  const { write, run } = setup(t);
  write({ 'cs.CV': sample({ label: 'Computer Vision' }) });
  assert.match(run().stderr, /cs\.CV: only a medicine or biology leaf/);
  write({ 'bio.unknown': sample({ label: 'bio unknown' }) });
  assert.match(run().stderr, /bio\.unknown: not a taxonomy leaf/);
});

test('records out of citation order, outside the window, repeated or unlabelled are refused', t => {
  const { write, run } = setup(t);
  const good = sample();
  write({ 'bio.gen': good });
  assert.equal(run().status, 0);
  const broken = [
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, citedByCount: 9500 } : work)) },
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, pubYear: '2026' } : work)) },
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, id: good.works[2].id } : work)) },
    { ...good, labels: good.labels.slice(1) },
    { ...good, hitCount: 10 },
  ];
  for (const value of broken) {
    write({ 'bio.gen': value });
    assert.notEqual(run().status, 0);
  }
});

test('--check detects a stale list', t => {
  const { write, run, output } = setup(t);
  write({ 'bio.gen': sample() });
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(output, `${readFileSync(output, 'utf8')}// edited\n`);
  assert.notEqual(run('--check').status, 0);
});
