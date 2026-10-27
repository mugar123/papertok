import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Synthetic samples; these do not establish live precision.
interface Options {
  leaf?: string; ownClass?: boolean; onTarget?: number; size?: number; uncertain?: number; capturedAt?: string;
  years?: string; sort?: string; params?: Record<string, string>; classes?: string[];
}

// The 15 most-cited records of a class over the ten completed years before
// the capture, citations falling from 900, the first `onTarget` on target and
// the next `uncertain` doubted. An own-class sample's records are filed under
// the leaf first; a listed sample's were cross-listed to it.
function sample({ leaf = 'nucl-th', ownClass = true, onTarget = 12, size = 15, uncertain = 0, capturedAt = '2026-10-26T20:32:00Z', years = '2016-2025', sort = 'citation_count desc', params = {}, classes }: Options = {}) {
  const query = new URL('https://api.adsabs.harvard.edu/v1/search/query');
  query.searchParams.set('q', `arxiv_class:"${leaf}" year:${years} doctype:(article OR eprint OR inproceedings)`);
  query.searchParams.set('fl', 'bibcode,title,abstract,year,pubdate,doi,identifier,arxiv_class,citation_count,doctype,pub,property');
  query.searchParams.set('rows', ownClass ? '2000' : '15');
  query.searchParams.set('start', '0');
  query.searchParams.set('sort', sort);
  for (const [name, value] of Object.entries(params)) query.searchParams.set(name, value);
  const works = Array.from({ length: size }, (_, index) => ({
    bibcode: `${2016 + (index % 10)}PhRvC.${100 + index}A`, title: `A synthetic landmark of the field, number ${index}`,
    year: String(2016 + (index % 10)), citationCount: 900 - index * 10,
    arxivClass: classes ?? (ownClass ? [leaf, 'hep-ph'] : ['astro-ph.HE', leaf]),
  }));
  const labels: Array<{ bibcode: string; label?: string; uncertain?: boolean }> = works.map((work, index) => (index < onTarget
    ? { bibcode: work.bibcode, label: 'on-target' }
    : index < onTarget + uncertain ? { bibcode: work.bibcode, uncertain: true } : { bibcode: work.bibcode, label: 'off-target' }));
  return { capturedAt, query: query.href, numFound: 5000, works, labels };
}
const samples = (leaf: string, ownClass: Options = {}) => ({ listed: sample({ leaf, ownClass: false, onTarget: 6 }), ownClass: sample({ leaf, ...ownClass }) });

function setup(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ads-notable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reviews = join(directory, 'reviews.json');
  const output = join(directory, 'leaves.ts');
  const report = join(directory, 'coverage.json');
  const write = (leaves: Record<string, unknown>) => writeFileSync(reviews, JSON.stringify({ leaves }));
  const run = (...extra: string[]) => spawnSync(process.execPath, [
    'scripts/generate-ads-notable-leaves.ts', '--reviews', reviews, '--out', output, '--report', report, ...extra,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  type Status = { status: string; sampleSize: number; onTarget: number };
  const coverage = () => JSON.parse(readFileSync(report, 'utf8')) as Array<{ leaf: string; listed: Status; ownClass: Status }>;
  const admitted = () => [...readFileSync(output, 'utf8').matchAll(/^ {2}'([^']+)',$/gm)].map(match => match[1]);
  return { write, run, coverage, admitted, output };
}

test('the checked-in ADS notable leaves are reproducible from the default inputs', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-ads-notable-leaves.ts', '--check'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a leaf is admitted by 10 of 15 own-class records on target without doubt, whatever its listed sample reads', t => {
  const { write, run, coverage, admitted } = setup(t);
  // Ten on target, one of them also doubted: 9 count.
  const doubted = sample({ leaf: 'math.GR', onTarget: 10 });
  doubted.labels[0] = { ...doubted.labels[0], uncertain: true };
  write({
    'nucl-th': samples('nucl-th', { onTarget: 10 }),
    'nucl-ex': { listed: sample({ leaf: 'nucl-ex', ownClass: false, onTarget: 15 }), ownClass: sample({ leaf: 'nucl-ex', onTarget: 9 }) },
    // 12 on target, three of them doubted: 9 count.
    'math.AG': samples('math.AG', { onTarget: 9, uncertain: 3 }),
    'math.GR': { listed: sample({ leaf: 'math.GR', ownClass: false }), ownClass: doubted },
    'math.GT': samples('math.GT', { size: 14, onTarget: 14 }),
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(coverage().map(row => [row.leaf, row.listed.status, row.ownClass.status, row.ownClass.onTarget, row.ownClass.sampleSize]), [
    ['math.AG', 'rejected', 'rejected', 9, 15],
    ['math.GR', 'passed', 'rejected', 9, 15],
    ['math.GT', 'rejected', 'insufficient-sample', 14, 14],
    ['nucl-ex', 'passed', 'rejected', 9, 15],
    ['nucl-th', 'rejected', 'passed', 10, 15],
  ]);
  assert.deepEqual(admitted(), ['nucl-th']);
});

test("a sample must be the leaf's ADS query over the ten completed years before its capture, most cited first", t => {
  const { write, run, admitted } = setup(t);
  write({ 'nucl-th': samples('nucl-th') });
  assert.equal(run().status, 0);
  const broken = [
    sample({ params: { q: 'arxiv_class:"nucl-ex" year:2016-2025 doctype:(article OR eprint OR inproceedings)' } }),
    sample({ years: '2015-2024' }),
    sample({ capturedAt: '2027-01-02T12:00:00Z' }),
    sample({ sort: 'date desc' }),
    sample({ params: { rows: '100' } }),
    sample({ params: { fl: 'bibcode,title' } }),
    sample({ params: { fq: 'property:refereed' } }),
  ];
  for (const ownClass of broken) {
    write({ 'nucl-th': { listed: sample({ ownClass: false, onTarget: 6 }), ownClass } });
    assert.notEqual(run().status, 0, ownClass.query);
    assert.deepEqual(admitted(), ['nucl-th'], 'a refused input leaves the output as it was');
  }
  write({ 'nucl-th': { listed: sample({ ownClass: false, params: { rows: '2000' } }), ownClass: sample() } });
  assert.notEqual(run().status, 0, 'the listed sample is the page of 15');
});

test('records out of citation order, outside the window, repeated or unlabelled are refused, and so is a leaf outside the taxonomy', t => {
  const { write, run } = setup(t);
  const good = sample();
  const nine = sample({ onTarget: 9 });
  write({ 'nucl-th': { listed: sample({ ownClass: false }), ownClass: good } });
  assert.equal(run().status, 0);
  const broken = [
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, citationCount: 950 } : work)) },
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, year: '2026' } : work)) },
    // The same record twice, labelled once.
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...good.works[2] } : work)), labels: good.labels.filter((_, index) => index !== 3) },
    { ...good, labels: good.labels.slice(1) },
    // Nine on target, the first labelled twice: counted twice, it would make ten.
    { ...nine, labels: [...nine.labels, nine.labels[0]] },
    { ...good, numFound: 10 },
    // A 16th record: the own-class query asks for 2,000 rows, and a sample keeps 15.
    { ...good, works: [...good.works, { ...good.works[14], bibcode: '2025PhRvC.199A', citationCount: 0 }], labels: [...good.labels, { bibcode: '2025PhRvC.199A', label: 'on-target' }] },
  ];
  for (const ownClass of broken) {
    write({ 'nucl-th': { listed: sample({ ownClass: false }), ownClass } });
    assert.notEqual(run().status, 0);
  }
  write({ 'nucl-xx': samples('nucl-xx') });
  assert.notEqual(run().status, 0, 'not a taxonomy leaf');
});

test('--check detects a stale list', t => {
  const { write, run, output } = setup(t);
  write({ 'nucl-th': samples('nucl-th') });
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(output, `${readFileSync(output, 'utf8')}// edited\n`);
  assert.notEqual(run('--check').status, 0);
});

test('an own-class record must be filed under the leaf first, and a listed one must name it', t => {
  const { write, run } = setup(t);
  write({ 'nucl-th': { listed: sample({ ownClass: false }), ownClass: sample({ classes: ['astro-ph.HE', 'nucl-th'] }) } });
  assert.notEqual(run().status, 0, 'a cross-listed record in the own-class sample');
  write({ 'nucl-th': { listed: sample({ ownClass: false, classes: ['astro-ph.HE'] }), ownClass: sample() } });
  assert.notEqual(run().status, 0, 'a listed record that does not name the leaf');
  write({ 'nucl-th': { listed: sample({ ownClass: false }), ownClass: sample() } });
  assert.equal(run().status, 0);
});
