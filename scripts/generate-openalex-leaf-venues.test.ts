import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Synthetic sources and samples; these do not establish live precision.
const curated = ['cs.AI', 'cs.CV', 'cs.DS', 'econ.EM', 'econ.GN', 'econ.TH', 'hep-ex', 'q-fin.PM'];
const sources = {
  S901: { name: 'Journal of Synthetic Econometrics', publisher: 'Example Press', type: 'journal', leaves: curated },
  S902: { name: 'Synthetic Economic Letters', publisher: 'Example Press', type: 'journal', leaves: curated },
  S903: { name: 'Synthetic Review of Estimation', publisher: null, type: 'journal', leaves: curated },
  S904: { name: 'Synthetic Methods Quarterly', publisher: 'Example Press', type: 'journal', leaves: curated },
  // Sampled for a leaf, but its curator left it off every list.
  S905: { name: 'Synthetic Insurance Review', publisher: 'Example Press', type: 'journal', leaves: [] },
  // A listed working-paper series, filed by OpenAlex as a journal.
  S2809516038: { name: 'National Bureau of Economic Research', publisher: null, type: 'journal', leaves: ['econ.GN'] },
};

interface Options {
  asked?: string[]; from?: string[]; onTarget?: number; size?: number; uncertain?: number;
  types?: string; extra?: string[]; capturedAt?: string; to?: string; params?: Record<string, string>; abstract?: boolean;
}

// The 15 newest works of `asked`, in turn from the sources in `from`, the
// first `onTarget` of them on target and the next `uncertain` doubted.
function sample({ asked = ['S901', 'S902', 'S903'], from = asked, onTarget = 12, size = 15, uncertain = 0, types = 'article', extra = [], capturedAt = '2026-10-22T12:00:00Z', to = '2026-10-22', params = {}, abstract = true }: Options = {}) {
  const start = new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const query = new URL('https://api.openalex.org/works');
  query.searchParams.set('filter', [`primary_location.source.id:${asked.join('|')}`, `type:${types}`, `from_publication_date:${start}`, `to_publication_date:${to}`, 'is_retracted:false', ...(abstract ? ['has_abstract:true'] : []), ...extra].join(','));
  query.searchParams.set('sort', 'publication_date:desc');
  query.searchParams.set('page', '1');
  query.searchParams.set('per-page', '15');
  for (const [name, value] of Object.entries(params)) query.searchParams.set(name, value);
  const works = Array.from({ length: size }, (_, index) => ({
    id: `https://openalex.org/W99${String(index).padStart(4, '0')}${from[0].slice(1)}`,
    type: types.split('|')[0], title: `Synthetic estimation result ${index}`, publication_date: '2026-10-20', source: from[index % from.length],
  }));
  const labels = works.map((work, index) => (index < onTarget
    ? { workId: work.id, label: 'on-target' }
    : index < onTarget + uncertain ? { workId: work.id, uncertain: true } : { workId: work.id, label: 'off-target' }));
  return { capturedAt, query: decodeURIComponent(query.href), works, labels };
}

interface NotableOptions {
  asked?: string[]; from?: string[]; onTarget?: number; size?: number; uncertain?: number; types?: string; extra?: string[];
  capturedAt?: string; window?: [string, string]; sort?: string; more?: string[];
}

// The 15 most-cited works of `asked` over the ten completed years before the
// capture, citations falling from 5000, the first `onTarget` on target.
function notableSample({ asked = ['S901', 'S902', 'S903'], from = asked, onTarget = 12, size = 15, uncertain = 0, types = 'article', extra = [], capturedAt = '2026-10-26T10:00:00Z', window = ['2016-01-01', '2025-12-31'], sort = 'cited_by_count:desc', more = [] }: NotableOptions = {}) {
  const query = new URL('https://api.openalex.org/works');
  query.searchParams.set('filter', [`primary_location.source.id:${asked.join('|')}`, `type:${types}`, ...extra, `from_publication_date:${window[0]}`, `to_publication_date:${window[1]}`, 'has_abstract:true', 'is_retracted:false', ...more].join(','));
  query.searchParams.set('sort', sort);
  query.searchParams.set('page', '1');
  query.searchParams.set('per-page', '15');
  const works = Array.from({ length: size }, (_, index) => ({
    id: `https://openalex.org/W88${String(index).padStart(4, '0')}${from[0].slice(1)}`,
    type: types.split('|')[0], title: `Synthetic landmark result ${index}`, publication_date: `${2016 + (index % 10)}-05-01`,
    source: from[index % from.length], cited_by_count: 5000 - index * 10,
  }));
  const labels = works.map((work, index) => (index < onTarget
    ? { workId: work.id, label: 'on-target' }
    : index < onTarget + uncertain ? { workId: work.id, uncertain: true } : { workId: work.id, label: 'off-target' }));
  return { capturedAt, query: decodeURIComponent(query.href), works, labels };
}

function setup(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pap104-venues-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reviews = join(directory, 'reviews.json');
  const output = join(directory, 'venues.ts');
  const report = join(directory, 'coverage.json');
  const write = (leaves: Record<string, unknown>, records: Record<string, unknown> = sources, notableSamples?: Record<string, unknown>) => writeFileSync(reviews, JSON.stringify({ sources: records, leaves, ...(notableSamples ? { notableSamples } : {}) }));
  const run = (...extra: string[]) => spawnSync(process.execPath, [
    'scripts/generate-openalex-leaf-venues.ts', '--reviews', reviews, '--out', output, '--report', report, ...extra,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const coverage = () => JSON.parse(readFileSync(report, 'utf8')) as Array<{
    leaf: string; status: string; sampleSize: number; onTarget: number; filters: string[]; sources: string[]; bySource: Record<string, string>;
    sourceSamples?: Record<string, string>; notable?: { status: string; sampleSize: number; onTarget: number };
  }>;
  return { write, run, coverage, output };
}

test('the checked-in venue lanes are reproducible from the default inputs', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-openalex-leaf-venues.ts', '--check'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a passing leaf asks for the sources its sample found on target, and for one whose own sample is two thirds on target', t => {
  const { write, run, coverage, output } = setup(t);
  // S902's two articles are off target; S904 is not in the 15 newest, but
  // its own 15 newest are 10 on target; S903 is in neither.
  const lane = sample({ asked: ['S901', 'S902', 'S903', 'S904'], from: ['S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S901', 'S902'], onTarget: 12 });
  write({ 'econ.EM': { sample: lane, sourceSamples: [sample({ asked: ['S904'], onTarget: 10 })] } });
  assert.equal(run().status, 0);
  const [row] = coverage();
  assert.deepEqual([row.leaf, row.status, row.onTarget, row.sampleSize], ['econ.EM', 'passed', 12, 15]);
  assert.deepEqual(row.bySource, { S901: '12/14', S902: '0/1', S903: '0/0', S904: '0/0' });
  assert.deepEqual(row.sources, ['S901', 'S904']);
  // The lane asks as the sample did, without has_abstract.
  assert.deepEqual(row.filters, ['type:article']);
  const text = readFileSync(output, 'utf8');
  assert.match(text, /'econ\.EM': \{\n {4}sources: \[\n {6}'S901', \/\/ Journal of Synthetic Econometrics \(Example Press\)\n {6}'S904', \/\/ Synthetic Methods Quarterly \(Example Press\)\n {4}\],\n {4}filters: \['type:article'\],/);
});

test('a short page, too few on target, or doubted calls give a leaf no lane, and an own sample below two thirds keeps its source out', t => {
  const { write, run, coverage, output } = setup(t);
  write({
    'cs.DS': { sample: sample({ size: 13, onTarget: 13 }) },
    'econ.GN': { sample: sample({ onTarget: 9 }) },
    // 12 on target, two of them doubted: 10 count.
    'econ.TH': { sample: sample({ asked: ['S901'], onTarget: 10, uncertain: 2 }) },
    'q-fin.PM': { sample: sample({ asked: ['S901'], onTarget: 8, uncertain: 2 }) },
    'econ.EM': { sample: sample({ asked: ['S901', 'S904'], from: ['S901'] }), sourceSamples: [sample({ asked: ['S904'], onTarget: 9 })] },
  });
  assert.equal(run().status, 0);
  const statuses = Object.fromEntries(coverage().map(row => [row.leaf, [row.status, row.sources]]));
  assert.deepEqual(statuses, {
    'cs.DS': ['insufficient-sample', []],
    'econ.EM': ['passed', ['S901']],
    'econ.GN': ['rejected', []],
    'econ.TH': ['passed', ['S901']],
    'q-fin.PM': ['rejected', []],
  });
  assert.deepEqual([...readFileSync(output, 'utf8').matchAll(/^ {2}'([^']+)': \{/gm)].map(match => match[1]), ['econ.EM', 'econ.TH']);
});

// q-fin.RM on 2026-10-23: the two insurance journals its curator excluded
// were 10 of 15 on target.
test('a source its curator did not file under the leaf stays out of the lane, whatever its sample', t => {
  const { write, run, coverage, output } = setup(t);
  write({
    // S905 is on target, but on no curated list; S901 is curated for econ.EM.
    'econ.EM': { sample: sample({ asked: ['S901', 'S905'], from: ['S901', 'S905'] }) },
    'q-fin.RM': { sample: sample({ asked: ['S905'], onTarget: 10 }) },
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const statuses = Object.fromEntries(coverage().map(row => [row.leaf, [row.status, row.onTarget, row.sources]]));
  assert.deepEqual(statuses, { 'econ.EM': ['passed', 12, ['S901']], 'q-fin.RM': ['not-curated', 10, []] });
  assert.deepEqual([...readFileSync(output, 'utf8').matchAll(/^ {2}'([^']+)': \{/gm)].map(match => match[1]), ['econ.EM']);
  // A filing must name taxonomy leaves.
  write({ 'econ.EM': { sample: sample() } }, { ...sources, S901: { ...sources.S901, leaves: ['econ.EMX'] } });
  assert.match(run().stderr, /S901: leaves must list the taxonomy leaves its curator filed it under/);
});

// The Journal of Financial and Quantitative Analysis entered q-fin.GN on 6 of 8
// articles, asked with has_abstract:true where q-fin.GN's sample was not.
test("a source's own sample passes only as the leaf's does: a full page of 15, asked with the leaf's filters", t => {
  const { write, run, coverage, output } = setup(t);
  const lane = sample({ asked: ['S901', 'S904'], from: ['S901'] });
  write({ 'econ.EM': { sample: lane, sourceSamples: [sample({ asked: ['S904'], size: 1, onTarget: 1 })] } });
  assert.equal(run().status, 0);
  const [row] = coverage();
  assert.deepEqual([row.sources, row.sourceSamples], [['S901'], { S904: '1/1' }]);
  const before = readFileSync(output, 'utf8');
  write({ 'econ.EM': { sample: sample({ asked: ['S901', 'S904'], from: ['S901'], abstract: false }), sourceSamples: [sample({ asked: ['S904'], onTarget: 15 })] } });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /econ\.EM: a source sample asks the leaf's filters of one of its sources, once/);
  assert.equal(readFileSync(output, 'utf8'), before);
});

test('a lane keeps the types and the topic or author filter its sample asked with', t => {
  const { write, run, coverage } = setup(t);
  const topics = sample({ extra: ['primary_topic.id:T2|T1'] });
  write({
    'cs.AI': { sample: sample({ types: 'article|conference-paper' }) },
    'econ.TH': { sample: { ...topics, works: topics.works.map((work, index) => ({ ...work, primary_topic: index % 2 ? 'T1' : 'T2' })) } },
    'hep-ex': { sample: sample({ extra: ['authors_count:>99'] }) },
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(coverage().map(row => [row.leaf, row.filters]), [
    ['cs.AI', ['type:article|conference-paper']],
    ['econ.TH', ['type:article', 'primary_topic.id:T1|T2']],
    ['hep-ex', ['type:article', 'authors_count:>99']],
  ]);
});

test('a sample that names the sampler, another filter, another window, a work outside its sources or topics, or works out of date order fails without overwriting output', t => {
  const { write, run, output } = setup(t);
  write({ 'econ.EM': { sample: sample() } });
  assert.equal(run().status, 0);
  const before = readFileSync(output, 'utf8');
  const broken = [
    sample({ params: { mailto: 'someone@example.org' } }),
    sample({ extra: ['primary_location.source.is_core:true'] }),
    sample({ to: '2026-10-20' }),
    { ...sample(), works: sample().works.map((work, index) => (index ? work : { ...work, source: 'S999' })) },
    { ...sample(), labels: sample().labels.slice(1) },
    { ...sample({ extra: ['primary_topic.id:T1'] }), works: sample().works.map(work => ({ ...work, primary_topic: 'T2' })) },
    { ...sample(), works: sample().works.map((work, index) => ({ ...work, publication_date: `2026-10-${String(index + 1).padStart(2, '0')}` })) },
  ];
  for (const value of broken) {
    write({ 'econ.EM': { sample: value } });
    assert.notEqual(run().status, 0, value.query);
    assert.equal(readFileSync(output, 'utf8'), before);
  }
});

test('a listed working-paper series cannot enter a lane, whatever its sample', t => {
  const { write, run } = setup(t);
  write({ 'econ.GN': { sample: sample({ asked: ['S2809516038'], onTarget: 15 }) } });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /S2809516038 \(National Bureau of Economic Research\) is not a venue the review rule calls reviewed/);
});

test('--check detects stale venue lanes', t => {
  const { write, run, output } = setup(t);
  write({ 'econ.EM': { sample: sample() } });
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(output, `${readFileSync(output, 'utf8')}// edited\n`);
  assert.notEqual(run('--check').status, 0);
});

const notableLeavesIn = (text: string) => text.match(/OPENALEX_NOTABLE_VENUE_LEAVES: readonly string\[\] = Object\.freeze\(\[\n((?: {2}'[^']+',\n)*)\]\);/)?.[1]
  .split('\n').filter(Boolean).map(line => line.trim().slice(1, -2));

test("a leaf whose ten-year most-cited journal articles are two thirds on target gets a notable lane from its journals", t => {
  const { write, run, coverage, output } = setup(t);
  write({ 'econ.EM': { sample: sample() } }, sources, { 'econ.EM': notableSample({ onTarget: 10 }) });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(coverage()[0].notable, { status: 'passed', sampleSize: 15, onTarget: 10 });
  assert.deepEqual(notableLeavesIn(readFileSync(output, 'utf8')), ['econ.EM']);
});

test('nine of fifteen on target, two of them doubted, or a short page gives no notable lane', t => {
  const { write, run, coverage, output } = setup(t);
  write({ 'econ.EM': { sample: sample() }, 'econ.GN': { sample: sample() }, 'econ.TH': { sample: sample() } }, sources, {
    'econ.EM': notableSample({ onTarget: 9 }),
    'econ.GN': notableSample({ onTarget: 9, uncertain: 2 }),
    'econ.TH': notableSample({ size: 14, onTarget: 14 }),
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(coverage().map(row => [row.leaf, row.notable?.status]), [['econ.EM', 'rejected'], ['econ.GN', 'rejected'], ['econ.TH', 'insufficient-sample']]);
  assert.deepEqual(notableLeavesIn(readFileSync(output, 'utf8')), []);
});

test("a notable sample must ask the leaf's own journals, types and extra filter over the ten completed years, most cited first", t => {
  const { write, run, output } = setup(t);
  write({ 'econ.EM': { sample: sample() } }, sources, { 'econ.EM': notableSample() });
  assert.equal(run().status, 0);
  const before = readFileSync(output, 'utf8');
  const broken = [
    notableSample({ sort: 'publication_date:desc' }),
    notableSample({ more: ['primary_location.source.is_core:true'] }),
    notableSample({ window: ['2015-01-01', '2024-12-31'] }),
    notableSample({ asked: ['S901', 'S902'] }),
    notableSample({ types: 'article|conference-paper' }),
  ];
  for (const value of broken) {
    write({ 'econ.EM': { sample: sample() } }, sources, { 'econ.EM': value });
    assert.notEqual(run().status, 0, value.query);
    assert.equal(readFileSync(output, 'utf8'), before);
  }
});

test("a notable sample of a lane with a topic filter asks for the lane's topics, and every work is on one of them", t => {
  const { write, run, output } = setup(t);
  const onTopics = <T extends { works: object[] }>(value: T) => ({ ...value, works: value.works.map((work, index) => ({ ...work, primary_topic: index % 2 ? 'T1' : 'T2' })) });
  const lane = { sample: onTopics(sample({ extra: ['primary_topic.id:T2|T1'] })) };
  write({ 'econ.TH': lane }, sources, { 'econ.TH': onTopics(notableSample({ extra: ['primary_topic.id:T1|T2'] })) });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(notableLeavesIn(readFileSync(output, 'utf8')), ['econ.TH']);
  const before = readFileSync(output, 'utf8');
  const good = onTopics(notableSample({ extra: ['primary_topic.id:T1|T2'] }));
  const broken = [
    onTopics(notableSample()),
    onTopics(notableSample({ extra: ['primary_topic.id:T2|T1'] })),
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, primary_topic: 'T3' } : work)) },
  ];
  for (const value of broken) {
    write({ 'econ.TH': lane }, sources, { 'econ.TH': value });
    assert.notEqual(run().status, 0, value.query);
    assert.equal(readFileSync(output, 'utf8'), before);
  }
});

test('a notable sample out of citation order, outside the window or with an unlabelled work is refused', t => {
  const { write, run } = setup(t);
  const good = notableSample();
  const broken = [
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, cited_by_count: 9000 } : work)) },
    { ...good, works: good.works.map((work, index) => (index === 3 ? { ...work, publication_date: '2026-01-02' } : work)) },
    { ...good, labels: good.labels.slice(1) },
  ];
  for (const value of broken) {
    write({ 'econ.EM': { sample: sample() } }, sources, { 'econ.EM': value });
    assert.notEqual(run().status, 0);
  }
});

test('a leaf with a notable lane from its topics, or without a venue lane, cannot take a journal notable sample', t => {
  const { write, run } = setup(t);
  write({ 'cs.CV': { sample: sample() } }, sources, { 'cs.CV': notableSample() });
  assert.match(run().stderr, /cs\.CV: has a notable lane from its topics/);
  write({ 'econ.GN': { sample: sample({ onTarget: 9 }) } }, sources, { 'econ.GN': notableSample() });
  assert.match(run().stderr, /econ\.GN: a notable sample needs the leaf's venue lane/);
});
