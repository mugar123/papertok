import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';
import { openAlexNotableFilterForLeaf } from '../src/utils/area-accent.ts';
import { openAlexPeerReviewed } from '../src/utils/publication-status.ts';

// The journals (and, in computer science, statistics and electrical
// engineering, the proceedings) whose newest articles stand for a leaf, by
// OpenAlex source ID (PAP-104). Each leaf's evidence is a labelled sample: its
// sources' 15 newest articles, asked with the lane's types and topic or author
// filter, and, for econ.GN and every leaf outside economics and finance, with
// has_abstract:true, which the lane does not ask.
// scripts/README-openalex-leaf-venues.md describes the inputs.

interface Work { id: string; type: string; title: string; publication_date: string; source: string; primary_topic?: string; cited_by_count?: number }
interface Sample {
  capturedAt: string;
  // The works URL as sent, without the sampler's address.
  query: string;
  works: Work[];
  // `uncertain` marks a call the labeller doubted; it counts as a miss.
  labels: Array<{ workId: string; label?: 'on-target' | 'off-target'; uncertain?: true }>;
}
// `leaves`: the leaves its curator filed it under; none for a source sampled
// but left off the curated lists.
interface Source { name: string; publisher: string | null; type: string; leaves: string[] }
interface Reviews {
  sources: Record<string, Source>;
  // `sample` decides the leaf; a source sample asks the leaf's filters of one
  // of its sources, for a source the leaf's sample did not reach.
  leaves: Record<string, { sample: Sample; sourceSamples?: Sample[] }>;
  // A leaf's 15 most-cited articles of its venue lane over the ten completed
  // years: the evidence for a notable lane from its journals.
  notableSamples?: Record<string, Sample>;
}

const leaves = getAllLeafCategories();
// The gate of the topic lanes (scripts/README-openalex-leaf-topics.md): one
// page of the 15 newest, at least two thirds on target without doubt.
const minimumSample = 15;
const minimumPrecision = 2 / 3;
// The notable lanes list the ten completed years before the current one
// (`NOTABLE_YEARS` in worker/paper-store.ts); their sample draws on the same years.
const notableYears = 10;
const DAY_MS = 86_400_000;
// OpenAlex types a proceedings paper `conference-paper`; computer science
// publishes in proceedings as much as in journals.
const LANE_TYPES = new Set(['article', 'article|conference-paper']);
// What a lane may add to its sources, where Pablo approved it: a topic, to
// keep a broad journal's part of a field (PRB's superconductivity), or an
// author count, to tell a collaboration's results from theory.
const EXTRA_FILTER = /^(?:primary_topic\.id:T\d+(?:\|T\d+)*|authors_count:[<>]\d+)$/;

const bare = (value: unknown) => String(value ?? '').split('/').pop()!;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const ratio = (onTarget: number, sampled: number) => `${onTarget}/${sampled}`;

// Every sampled work labelled once; the hits are the works on target without doubt.
function checkLabels(leaf: string, sample: Sample, workIds: Set<string>) {
  const labelled = new Set<string>();
  for (const label of sample.labels) {
    const id = bare(label?.workId);
    if (!workIds.has(id) || labelled.has(id) || ![undefined, true].includes(label.uncertain)
      || (label.label === undefined ? !label.uncertain : !['on-target', 'off-target'].includes(label.label))) {
      throw new Error(`${leaf}: invalid or duplicate label: ${id}`);
    }
    labelled.add(id);
  }
  if (labelled.size !== workIds.size) throw new Error(`${leaf}: label every sampled work; do not omit misses`);
  return new Set(sample.labels.filter(label => label.label === 'on-target' && !label.uncertain).map(label => bare(label.workId)));
}

function checkSample(leaf: string, value: unknown) {
  const sample = value as Sample | null;
  const invalid = (reason: string): never => { throw new Error(`${leaf}: ${reason}`); };
  if (!sample || typeof sample.query !== 'string' || !Array.isArray(sample.works) || !Array.isArray(sample.labels)) invalid('missing sample');
  const capturedAt = Date.parse(sample!.capturedAt);
  if (!Number.isFinite(capturedAt)) invalid('missing capture date');
  const query = new URL(sample!.query);
  const allowed = new Set(['filter', 'sort', 'page', 'per-page', 'select']);
  if (query.origin !== 'https://api.openalex.org' || query.pathname !== '/works' || query.username || query.password
    || [...query.searchParams.keys()].some(key => !allowed.has(key) || query.searchParams.getAll(key).length !== 1)
    || query.searchParams.get('sort') !== 'publication_date:desc'
    || query.searchParams.get('page') !== '1' || query.searchParams.get('per-page') !== String(minimumSample)) {
    invalid('sample must be the anonymous, newest-first page of 15, without the sampler\'s address');
  }
  const filters = query.searchParams.get('filter')?.split(',') || [];
  const take = (prefix: string) => {
    const found = filters.filter(filter => filter.startsWith(prefix));
    if (found.length > 1) invalid(`${prefix} named twice`);
    return found[0]?.slice(prefix.length);
  };
  const sources = take('primary_location.source.id:')?.split('|') || [];
  if (!sources.length || sources.some(id => !/^S\d+$/.test(id)) || new Set(sources).size !== sources.length) invalid('the query must name its source IDs once each');
  const types = take('type:') || '';
  if (!LANE_TYPES.has(types)) invalid(`type must be one of ${[...LANE_TYPES].join(', ')}`);
  // The window is the feed's 90 days. A sample taken after midnight UTC may
  // keep the window that ended the day before.
  const to = Date.parse(`${take('to_publication_date:')}T00:00:00Z`);
  const from = Date.parse(`${take('from_publication_date:')}T00:00:00Z`);
  if (![day(capturedAt), day(capturedAt - DAY_MS)].includes(day(to)) || from !== to - 90 * DAY_MS) invalid('sample must ask for the 90 days through its capture');
  if (take('is_retracted:') !== 'false') invalid('sample must leave out retracted works');
  const withAbstractOnly = take('has_abstract:');
  if (withAbstractOnly !== undefined && withAbstractOnly !== 'true') invalid('has_abstract may only be true');
  const extra = filters.filter(filter => !/^(?:primary_location\.source\.id|type|from_publication_date|to_publication_date|is_retracted|has_abstract):/.test(filter));
  if (extra.some(filter => !EXTRA_FILTER.test(filter)) || new Set(extra.map(filter => filter.split(':')[0])).size !== extra.length) {
    invalid(`only a topic or author-count filter may narrow the sources: ${extra.join(',')}`);
  }
  const topics = extra.find(filter => filter.startsWith('primary_topic.id:'))?.slice('primary_topic.id:'.length).split('|');

  if (sample!.works.length > minimumSample) invalid('a sample is one page of 15');
  const workIds = new Set<string>();
  let previousDate = day(to);
  for (const work of sample!.works) {
    const id = bare(work?.id);
    if (!/^W\d+$/.test(id) || workIds.has(id) || !types.split('|').includes(work.type)
      || typeof work.title !== 'string' || !work.title.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(work.publication_date)
      || work.publication_date < day(from) || work.publication_date > previousDate
      || !sources.includes(work.source)
      || (topics && !topics.includes(work.primary_topic!))) invalid(`invalid recent work: ${id}`);
    workIds.add(id);
    previousDate = work.publication_date;
  }
  const hits = checkLabels(leaf, sample!, workIds);
  const bySource = new Map(sources.map(id => {
    const works = sample!.works.filter(work => work.source === id);
    return [id, { sampled: works.length, onTarget: works.filter(work => hits.has(bare(work.id))).length }];
  }));
  return { sources, types, extra: extra.map(filter => (filter.startsWith('primary_topic.id:') ? `primary_topic.id:${[...topics!].sort().join('|')}` : filter)), withAbstractOnly: withAbstractOnly === 'true', sampleSize: workIds.size, onTarget: hits.size, bySource };
}

// A notable lane from a leaf's journals lists each year's most cited of its
// venue lane (`openAlexNotableListingFilter` in worker/paper-sources.ts),
// without the core-source filter of the topic notables: these sources passed
// the venue gate already. Its sample is the 15 most cited of the ten completed
// years before the capture, asked with has_abstract:true for the labellers.
function checkNotableSample(leaf: string, value: unknown, lane: { sources: string[]; filters: string[] }) {
  const sample = value as Sample | null;
  const invalid = (reason: string): never => { throw new Error(`${leaf}: ${reason}`); };
  if (!sample || typeof sample.query !== 'string' || !Array.isArray(sample.works) || !Array.isArray(sample.labels)) invalid('missing notable sample');
  const capturedAt = Date.parse(sample!.capturedAt);
  if (!Number.isFinite(capturedAt)) invalid('missing capture date');
  const year = new Date(capturedAt).getUTCFullYear();
  const firstDay = `${year - notableYears}-01-01`;
  const lastDay = `${year - 1}-12-31`;
  const required = [
    `primary_location.source.id:${lane.sources.join('|')}`, ...lane.filters,
    `from_publication_date:${firstDay}`, `to_publication_date:${lastDay}`, 'has_abstract:true', 'is_retracted:false',
  ];
  const query = new URL(sample!.query);
  const filters = query.searchParams.get('filter')?.split(',') || [];
  const allowed = new Set(['filter', 'sort', 'page', 'per-page', 'select']);
  if (query.origin !== 'https://api.openalex.org' || query.pathname !== '/works' || query.username || query.password
    || [...query.searchParams.keys()].some(key => !allowed.has(key) || query.searchParams.getAll(key).length !== 1)
    || query.searchParams.get('sort') !== 'cited_by_count:desc'
    || query.searchParams.get('page') !== '1' || query.searchParams.get('per-page') !== String(minimumSample)
    || filters.length !== required.length || required.some(filter => !filters.includes(filter))) {
    invalid("notable sample must be the anonymous, most-cited page of 15 of the leaf's venue lane over the ten completed years");
  }
  const types = lane.filters[0].slice('type:'.length).split('|');
  const topics = lane.filters.find(filter => filter.startsWith('primary_topic.id:'))?.slice('primary_topic.id:'.length).split('|');
  if (sample!.works.length > minimumSample) invalid('a sample is one page of 15');
  const workIds = new Set<string>();
  let previous = Infinity;
  for (const work of sample!.works) {
    const id = bare(work?.id);
    const cited = work?.cited_by_count;
    if (!/^W\d+$/.test(id) || workIds.has(id) || !types.includes(work.type)
      || typeof work.title !== 'string' || !work.title.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(work.publication_date)
      || work.publication_date < firstDay || work.publication_date > lastDay
      || !lane.sources.includes(work.source)
      || (topics && !topics.includes(work.primary_topic!))
      || !Number.isInteger(cited) || cited! < 0 || cited! > previous) invalid(`invalid notable work: ${id}`);
    workIds.add(id);
    previous = cited!;
  }
  const onTarget = checkLabels(leaf, sample!, workIds).size;
  const sampleSize = workIds.size;
  const status = sampleSize < minimumSample ? 'insufficient-sample' : onTarget / sampleSize >= minimumPrecision ? 'passed' : 'rejected';
  return { status, sampleSize, onTarget };
}

function checkLeaf(leaf: string, entry: Reviews['leaves'][string], records: Reviews['sources']) {
  const lane = checkSample(leaf, entry?.sample);
  const precision = lane.sampleSize ? lane.onTarget / lane.sampleSize : null;
  const status = lane.sampleSize < minimumSample ? 'insufficient-sample' : precision! >= minimumPrecision ? 'passed' : 'rejected';
  // A source sample answers for one of the leaf's sources, asked as the leaf
  // asks: the same types, abstract filter and topic or author filter.
  const ownSamples = new Map<string, { sampled: number; onTarget: number }>();
  for (const value of entry.sourceSamples || []) {
    const own = checkSample(leaf, value);
    const [id] = own.sources;
    if (own.sources.length !== 1 || !lane.sources.includes(id) || ownSamples.has(id) || own.types !== lane.types
      || own.withAbstractOnly !== lane.withAbstractOnly || own.extra.join() !== lane.extra.join()) {
      throw new Error(`${leaf}: a source sample asks the leaf's filters of one of its sources, once`);
    }
    ownSamples.set(id, own.bySource.get(id)!);
  }
  // Only a source its curator filed under the leaf can enter its lane: a sample
  // tests the curated list, it does not add to it.
  const curated = (id: string) => Array.isArray(records[id]?.leaves) && records[id].leaves.includes(leaf);
  // The leaf's precision says nothing about a source its sample never reached,
  // or reached only off target: the lane leaves it out unless a sample of its
  // own passes the leaf's gate, a full page of 15 two thirds on target.
  const ownPasses = (id: string) => {
    const own = ownSamples.get(id);
    return own !== undefined && own.sampled >= minimumSample && own.onTarget / own.sampled >= minimumPrecision;
  };
  const admitted = status !== 'passed' ? [] : lane.sources.filter(id => curated(id) && (lane.bySource.get(id)!.onTarget > 0 || ownPasses(id)));
  for (const id of admitted) {
    const record = records[id];
    if (typeof record.name !== 'string' || !record.name.trim() || (record.publisher !== null && typeof record.publisher !== 'string')) {
      throw new Error(`${leaf}: ${id} needs its verified name, publisher and type`);
    }
    // Its articles must read reviewed, by the venue rule, and not as a listed
    // working-paper series.
    const reviewed = openAlexPeerReviewed({ type: 'article', primary_location: { source: { id: `https://openalex.org/${id}`, display_name: record.name, type: record.type } } });
    if (reviewed !== true) throw new Error(`${leaf}: ${id} (${record.name}) is not a venue the review rule calls reviewed`);
  }
  return {
    // A passing sample whose on-target sources are all off the curated list
    // gives the leaf no lane.
    status: status === 'passed' && !admitted.length ? 'not-curated' : status,
    sampleSize: lane.sampleSize,
    onTarget: lane.onTarget,
    precision,
    withAbstractOnly: lane.withAbstractOnly,
    filters: [`type:${lane.types}`, ...lane.extra],
    bySource: Object.fromEntries([...lane.bySource].map(([id, count]) => [id, ratio(count.onTarget, count.sampled)])),
    ...(ownSamples.size ? { sourceSamples: Object.fromEntries([...ownSamples].map(([id, count]) => [id, ratio(count.onTarget, count.sampled)])) } : {}),
    sources: admitted.sort(),
  };
}

const { values } = parseArgs({ options: {
  reviews: { type: 'string', default: fileURLToPath(new URL('./data/openalex-venue-reviews.json', import.meta.url)) },
  report: { type: 'string', default: fileURLToPath(new URL('./data/openalex-leaf-venues-coverage.json', import.meta.url)) },
  out: { type: 'string', default: fileURLToPath(new URL('../worker/openalex-leaf-venues.generated.ts', import.meta.url)) },
  check: { type: 'boolean', default: false },
} });
const reviews = JSON.parse(readFileSync(values.reviews!, 'utf8')) as Reviews;
if (!reviews?.sources || typeof reviews.sources !== 'object' || !reviews.leaves || typeof reviews.leaves !== 'object') {
  throw new Error('Reviews must hold the verified sources and the samples keyed by taxonomy leaf ID');
}
for (const [id, record] of Object.entries(reviews.sources)) {
  if (!Array.isArray(record?.leaves) || record.leaves.some(leaf => !leaves.some(item => item.id === leaf))) {
    throw new Error(`${id}: leaves must list the taxonomy leaves its curator filed it under`);
  }
}
const notableSamples = reviews.notableSamples ?? {};
if (typeof notableSamples !== 'object' || Array.isArray(notableSamples)) throw new Error('Notable samples must be keyed by taxonomy leaf ID');
for (const leaf of Object.keys(notableSamples)) {
  if (!Object.hasOwn(reviews.leaves, leaf)) throw new Error(`${leaf}: a notable sample needs the leaf's venue lane`);
}
const report = Object.keys(reviews.leaves).sort().map(leaf => {
  const known = leaves.find(item => item.id === leaf);
  if (!known) throw new Error(`Review must name a taxonomy leaf: ${leaf}`);
  const row = { leaf, label: known.label, ...checkLeaf(leaf, reviews.leaves[leaf], reviews.sources) };
  if (!Object.hasOwn(notableSamples, leaf)) return row;
  // A leaf with a topic notable lane lists its topics' most cited; a second
  // OpenAlex listing for the same lane would only repeat or blur it.
  if (row.status !== 'passed') throw new Error(`${leaf}: a notable sample needs the leaf's venue lane`);
  if (openAlexNotableFilterForLeaf(leaf) !== null) throw new Error(`${leaf}: has a notable lane from its topics`);
  return { ...row, notable: checkNotableSample(leaf, notableSamples[leaf], row) };
});
const lanes = report.filter(row => row.status === 'passed');
const notableLeaves = report.flatMap(row => ('notable' in row && row.notable.status === 'passed' ? [row.leaf] : []));
const sourceLine = (id: string) => {
  const { name, publisher } = reviews.sources[id];
  return `      '${id}', // ${name}${publisher ? ` (${publisher})` : ''}`;
};
const output = [
  '// Generated by scripts/generate-openalex-leaf-venues.ts from scripts/data/openalex-venue-reviews.json; do not edit.',
  'export const OPENALEX_LEAF_VENUES: Readonly<Record<string, { readonly sources: readonly string[]; readonly filters: readonly string[] }>> = Object.freeze({',
  ...lanes.flatMap(row => [
    `  '${row.leaf}': {`,
    '    sources: [',
    ...row.sources.map(sourceLine),
    '    ],',
    `    filters: [${row.filters.map(filter => `'${filter}'`).join(', ')}],`,
    '  },',
  ]),
  '});',
  '',
  "// The leaves whose notable lane lists the most-cited articles of their venue lane above: their notable sample passed.",
  'export const OPENALEX_NOTABLE_VENUE_LEAVES: readonly string[] = Object.freeze([',
  ...notableLeaves.map(leaf => `  '${leaf}',`),
  ']);', '',
].join('\n');
const files = [[resolve(values.out!), output], [resolve(values.report!), `${JSON.stringify(report, null, 2)}\n`]];
for (const [path, text] of files) {
  if (!values.check) writeFileSync(path, text);
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} is stale; regenerate with the same reviews`);
}
process.stdout.write(`${lanes.length} of ${report.length} reviewed leaves have a venue lane, from ${new Set(lanes.flatMap(row => row.sources)).size} sources; `
  + `${notableLeaves.length} of ${Object.keys(notableSamples).length} sampled have a notable lane from their journals\n`);
