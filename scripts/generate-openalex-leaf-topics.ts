import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';
import { openAlexFilterForArea } from '../src/data/open-alex-areas.ts';

interface Topic {
  id: string; display_name: string; keywords?: string[];
  field?: { id: string }; subfield?: { id: string };
}
interface Work { id: string; title: string; type: string; publication_date: string; primary_topic: { id: string }; cited_by_count?: number }
interface Review {
  capturedAt: string;
  query: string;
  // Only the fields checked below; the query's has_abstract:true proves the
  // abstracts, and the work IDs lead back to the full records. A notable
  // sample's works also keep `cited_by_count`, the order OpenAlex returned them in.
  works: Work[];
  // `uncertain` marks a call the labeller doubted; it counts as a miss. A
  // doubted call has no label when the labeller leaned neither way.
  labels: Array<{ workId: string; label?: 'on-target' | 'off-target'; uncertain?: true }>;
}

const leaves = getAllLeafCategories();
// The sample is one page of 15 (PAP-99); a leaf with fewer in the population
// cannot pass.
const minimumSample = 15;
// PR #236's lowest accepted profile was 66.0%; use the next exact fraction.
const minimumPrecision = 2 / 3;
// The notable lanes list the ten completed years before the current one
// (`NOTABLE_YEARS` in worker/paper-store.ts); their sample draws on the same years.
const notableYears = 10;
// OpenAlex ORs at most 100 values in one filter.
const maximumFilterValues = 100;
const sampleSelect = 'id,doi,title,type,publication_date,publication_year,language,abstract_inverted_index,primary_location,open_access,primary_topic';
const DAY_MS = 86_400_000;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const baseline = JSON.parse(readFileSync(new URL('./data/openalex-leaf-topics-baseline.json', import.meta.url), 'utf8')) as {
  topics: Record<string, string[]>;
};
const stopWords = new Set(words('and of the general science engineering physics applied theory theoretical applications'));

// The two populations a leaf is sampled from (scripts/README-openalex-leaf-topics.md):
// a topic lane's 15 newest articles of the last 90 days, and a notable lane's 15
// most cited of the ten completed years before the capture.
const POPULATIONS = {
  recent: {
    sort: 'publication_date:desc',
    window: (capturedAt: number) => [day(capturedAt - 90 * DAY_MS), day(capturedAt)],
    // OpenAlex returned the works newest first; the review keeps that order.
    inOrder: (work: Work, previous: Work | undefined) => !previous || work.publication_date <= previous.publication_date,
  },
  notable: {
    sort: 'cited_by_count:desc',
    window: (capturedAt: number) => {
      const year = new Date(capturedAt).getUTCFullYear();
      return [`${year - notableYears}-01-01`, `${year - 1}-12-31`];
    },
    inOrder: (work: Work, previous: Work | undefined) => Number.isInteger(work.cited_by_count) && work.cited_by_count! >= 0
      && (!previous || work.cited_by_count! <= previous.cited_by_count!),
  },
};

function words(text: string) {
  return text.toLowerCase().match(/[a-z]+/g)?.map(word => word.replace(/ies$/, 'y').replace(/s$/, '')) || [];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readCatalogue(value: unknown): Topic[] {
  const topics = Array.isArray(value) ? value : (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(topics)) throw new Error('Catalogue must be a topic array or an OpenAlex results array');
  const ids = new Set<string>();
  return topics.map((topic: Topic) => {
    const id = String(topic?.id || '').split('/').pop()!;
    if (!/^T\d+$/.test(id) || typeof topic.display_name !== 'string'
      || (topic.keywords !== undefined && (!Array.isArray(topic.keywords) || topic.keywords.some(word => typeof word !== 'string')))
      || ids.has(id)) throw new Error(`Invalid or duplicate catalogue topic: ${id}`);
    ids.add(id);
    return { ...topic, id };
  });
}

function candidatesForLeaf(leaf: typeof leaves[number], catalogue: Topic[]) {
  let terms = [...new Set(words(leaf.label).filter(word => !stopWords.has(word)))];
  if (!terms.length) terms = words(leaf.areaLabel).filter(word => !stopWords.has(word));
  if (!terms.length) return [];
  const areaFilter = openAlexFilterForArea(leaf.area);
  const [ancestor, ids] = areaFilter?.split(':') || [];
  const allowedIds = ids?.split('|') || [];
  return catalogue.filter(topic => {
    const id = ancestor === 'primary_topic.field.id' ? topic.field?.id : topic.subfield?.id;
    return id && allowedIds.includes(topicKey(id));
  }).map(topic => {
    const name = new Set(words(topic.display_name));
    const keywords = new Set(words((topic.keywords || []).join(' ')));
    const matches = terms.filter(term => name.has(term) || keywords.has(term));
    const score = matches.reduce((sum, term) => sum + (name.has(term) ? 4 : 1), 0);
    return { id: topic.id, score, coverage: matches.length / terms.length };
  }).filter(topic => topic.coverage >= 0.6)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'))
    .slice(0, 10).map(topic => topic.id);
}

/**
 * A notable lane's candidates: the catalogue topics of the subfields the map
 * names for the leaf, plus any topic it names by ID (one OpenAlex files under
 * another subfield). Not label matching, which proposed off-target topics
 * (`cs.AI`: 0 of 15 on target on 2026-10-23).
 */
function notableCandidatesForLeaf(leaf: string, ids: unknown, catalogue: Topic[]) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error(`${leaf}: notable subfields must be an array of subfield or topic IDs`);
  const known = (id: string) => /^\d{4}$/.test(id) ? catalogue.some(topic => topicKey(topic.subfield?.id) === id) : /^T\d+$/.test(id) && catalogue.some(topic => topic.id === id);
  const unknown = ids.filter(id => !known(id));
  if (unknown.length) throw new Error(`${leaf}: unknown subfield or topic: ${unknown.join(', ')}`);
  return catalogue.filter(topic => ids.includes(topicKey(topic.subfield?.id)) || ids.includes(topic.id)).map(topic => topic.id).sort();
}

/** The blind sample's query: the Worker's notable filters over the candidates, plus has_abstract:true, since the labellers read the abstracts. */
function notableSampleUrl(topicIds: string[], year: number) {
  const url = new URL('https://api.openalex.org/works');
  const [firstDay, lastDay] = POPULATIONS.notable.window(Date.UTC(year, 0, 1));
  url.searchParams.set('filter', [
    `primary_topic.id:${topicIds.join('|')}`, 'type:article',
    `from_publication_date:${firstDay}`, `to_publication_date:${lastDay}`,
    'has_abstract:true', 'is_retracted:false', 'primary_location.source.is_core:true',
  ].join(','));
  url.searchParams.set('sort', POPULATIONS.notable.sort);
  url.searchParams.set('page', '1');
  url.searchParams.set('per-page', String(minimumSample));
  url.searchParams.set('select', `${sampleSelect},cited_by_count`);
  return url.href;
}

function topicKey(value: string | undefined) {
  return String(value || '').split('/').pop()!;
}

function checkReview(leaf: string, value: unknown, population: keyof typeof POPULATIONS) {
  const review = value as Review | null;
  const invalid = (reason: string): never => { throw new Error(`${leaf}: ${reason}`); };
  if (!review || typeof review.query !== 'string') invalid('missing review');
  const capturedAt = Date.parse(review!.capturedAt);
  if (!Number.isFinite(capturedAt)) invalid('missing capture date');
  const { sort, window, inOrder } = POPULATIONS[population];
  const [firstDay, lastDay] = window(capturedAt);
  const query = new URL(review!.query);
  const filters = query.searchParams.get('filter')?.split(',') || [];
  // The topics the sample asked for are the ones it is evidence for; the label
  // and the catalogue only proposed them, so editing either keeps the review.
  const topicIds = filters.find(filter => filter.startsWith('primary_topic.id:'))?.slice('primary_topic.id:'.length).split('|') || [];
  if (!topicIds.length || topicIds.some(id => !/^T\d+$/.test(id)) || topicIds.join() !== [...new Set(topicIds)].sort().join()) {
    invalid('the query must name its topic IDs once each, sorted');
  }
  const required = [
    `primary_topic.id:${topicIds.join('|')}`, 'type:article',
    `from_publication_date:${firstDay}`, `to_publication_date:${lastDay}`,
    // The labellers read the abstracts; the lane takes articles without one.
    'has_abstract:true', 'is_retracted:false', 'primary_location.source.is_core:true',
  ];
  const allowedParams = new Set(['filter', 'sort', 'page', 'per-page', 'mailto', 'select']);
  if (query.origin !== 'https://api.openalex.org' || query.pathname !== '/works'
    || query.username || query.password
    || [...query.searchParams.keys()].some(key => !allowedParams.has(key) || query.searchParams.getAll(key).length !== 1)
    || query.searchParams.get('sort') !== sort
    || query.searchParams.get('page') !== '1' || query.searchParams.get('per-page') !== String(minimumSample)
    || filters.length !== required.length || required.some(filter => !filters.includes(filter))) {
    invalid(`sample must use the anonymous ${population === 'recent' ? 'newest-first feed' : 'most-cited notable'} query, not text or subfield search`);
  }
  if (!Array.isArray(review!.works) || review!.works.length > minimumSample || !Array.isArray(review!.labels)) invalid('invalid sample or labels');
  const workIds = new Set<string>();
  let previous: Work | undefined;
  for (const work of review!.works) {
    const id = topicKey(work?.id);
    if (!/^W\d+$/.test(id) || workIds.has(id) || work.type !== 'article'
      || typeof work.title !== 'string' || !work.title.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(work.publication_date)
      || work.publication_date < firstDay || work.publication_date > lastDay
      || !inOrder(work, previous)
      || !topicIds.includes(topicKey(work.primary_topic?.id))) invalid(`invalid sampled article: ${id}`);
    workIds.add(id);
    previous = work;
  }
  const labels = new Set<string>();
  for (const label of review!.labels) {
    const id = topicKey(label?.workId);
    if (!workIds.has(id) || labels.has(id) || ![undefined, true].includes(label.uncertain)
      || (label.label === undefined ? !label.uncertain : !['on-target', 'off-target'].includes(label.label))) {
      invalid(`invalid or duplicate label: ${id}`);
    }
    labels.add(id);
  }
  if (labels.size !== workIds.size) invalid('label every sampled article; do not omit misses');
  const sampleSize = workIds.size;
  const hits = new Set(review!.labels.filter(label => label.label === 'on-target' && !label.uncertain).map(label => topicKey(label.workId)));
  const onTarget = hits.size;
  const precision = sampleSize ? onTarget / sampleSize : null;
  const status = sampleSize < minimumSample ? 'insufficient-sample'
    : precision! >= minimumPrecision ? 'passed' : 'rejected';
  // A passing leaf's precision says nothing about a topic with no sampled
  // article on target, such as a generic catch-all, so its lane leaves it out.
  const counts = topicIds.map(topic => {
    const works = review!.works.filter(work => topicKey(work.primary_topic.id) === topic);
    return { topic, sampled: works.length, onTarget: works.filter(work => hits.has(topicKey(work.id))).length };
  });
  const byTopic = Object.fromEntries(counts.map(count => [count.topic, `${count.onTarget}/${count.sampled}`]));
  const onTargetTopics = counts.filter(count => count.onTarget).map(count => count.topic);
  return { topicIds, status, sampleSize, onTarget, precision, byTopic, onTargetTopics };
}

function readRecord(path: string, what: string) {
  const value = readJson(path) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be keyed by taxonomy leaf ID`);
  return value;
}

function topicMap(name: string, active: Record<string, string[]>) {
  return [
    '// Generated by scripts/generate-openalex-leaf-topics.ts; do not edit.',
    `export const ${name}: Readonly<Record<string, readonly string[]>> = Object.freeze({`,
    ...Object.keys(active).sort().map(leaf => `  '${leaf}': [${active[leaf].map(id => `'${id}'`).join(', ')}],`),
    '});', '',
  ].join('\n');
}

const defaultPath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const { values } = parseArgs({ options: {
  catalogue: { type: 'string', default: defaultPath('./data/openalex-topic-catalogue.json') },
  reviews: { type: 'string', default: defaultPath('./data/openalex-topic-reviews.json') },
  report: { type: 'string', default: defaultPath('./data/openalex-leaf-topics-coverage.json') },
  out: { type: 'string', default: defaultPath('../src/data/open-alex-leaf-topics.generated.ts') },
  subfields: { type: 'string', default: defaultPath('./data/openalex-notable-subfields.json') },
  'notable-reviews': { type: 'string', default: defaultPath('./data/openalex-notable-reviews.json') },
  candidates: { type: 'string', default: defaultPath('./data/openalex-notable-candidates.json') },
  'notable-out': { type: 'string', default: defaultPath('../src/data/open-alex-notable-leaf-topics.generated.ts') },
  check: { type: 'boolean', default: false },
} });
const catalogue = readCatalogue(readJson(values.catalogue!));
const reviews = readRecord(values.reviews!, 'Reviews');
for (const leaf of Object.keys(reviews)) {
  if (!leaves.some(item => item.id === leaf) || baseline.topics[leaf]) throw new Error(`Review must name a new taxonomy leaf: ${leaf}`);
}
const active = { ...baseline.topics };
const report = leaves.map(leaf => {
  const row = { leaf: leaf.id, label: leaf.label };
  if (baseline.topics[leaf.id]) return { ...row, topicIds: baseline.topics[leaf.id], status: 'inherited' };
  if (Object.hasOwn(reviews, leaf.id)) {
    const { onTargetTopics, ...result } = checkReview(leaf.id, reviews[leaf.id], 'recent');
    if (result.status === 'passed') active[leaf.id] = onTargetTopics;
    return { ...row, ...result };
  }
  const topicIds = candidatesForLeaf(leaf, catalogue);
  return { ...row, topicIds, status: topicIds.length ? 'not-reviewed' : catalogue.length ? 'no-candidates' : 'no-catalogue' };
});

// The notable lanes of the leaves without a topic lane: a leaf with one lists
// its topic lane's topics (openAlexNotableFilterForLeaf, area-accent.ts), so
// the notable map and its inputs name only the others.
const subfields = readRecord(values.subfields!, 'Notable subfields');
const notableReviews = readRecord(values['notable-reviews']!, 'Notable reviews');
for (const leaf of Object.keys(subfields)) {
  if (!leaves.some(item => item.id === leaf)) throw new Error(`Notable subfields must name a taxonomy leaf: ${leaf}`);
  if (active[leaf]) throw new Error(`Notable subfields name a leaf with a topic lane, whose notable lane lists its topics: ${leaf}`);
}
for (const leaf of Object.keys(notableReviews)) {
  if (!Object.hasOwn(subfields, leaf)) throw new Error(`Notable review must name a leaf of the notable subfields map: ${leaf}`);
}
// The proposals' window moves each January; `--check` keeps the one the file
// recorded, as a review's own window comes from its capture date.
const recorded = values.check && existsSync(values.candidates!) ? (readJson(values.candidates!) as { year?: unknown } | null)?.year : undefined;
const year = typeof recorded === 'number' ? recorded : new Date().getUTCFullYear();
const notableActive: Record<string, string[]> = {};
const candidates = leaves.filter(leaf => !active[leaf.id]).map(leaf => {
  const row = { leaf: leaf.id, label: leaf.label };
  if (!Object.hasOwn(subfields, leaf.id)) return { ...row, subfields: [], topicIds: [], status: 'not-mapped' };
  const ids = subfields[leaf.id] as string[];
  const topicIds = notableCandidatesForLeaf(leaf.id, ids, catalogue);
  if (Object.hasOwn(notableReviews, leaf.id)) {
    const { onTargetTopics, ...result } = checkReview(leaf.id, notableReviews[leaf.id], 'notable');
    if (result.status === 'passed') notableActive[leaf.id] = onTargetTopics;
    return { ...row, subfields: ids, ...result };
  }
  if (!topicIds.length) return { ...row, subfields: ids, topicIds, status: 'no-candidates' };
  if (topicIds.length > maximumFilterValues) return { ...row, subfields: ids, topicIds, status: 'too-many-candidates' };
  return { ...row, subfields: ids, topicIds, status: 'not-reviewed', sampleUrl: notableSampleUrl(topicIds, year) };
});
const files = [
  [resolve(values.out!), topicMap('OPENALEX_LEAF_TOPICS', active)],
  [resolve(values.report!), `${JSON.stringify(report, null, 2)}\n`],
  [resolve(values['notable-out']!), topicMap('OPENALEX_NOTABLE_LEAF_TOPICS', notableActive)],
  [resolve(values.candidates!), `${JSON.stringify({ year, leaves: candidates }, null, 2)}\n`],
];
for (const [path, text] of files) {
  if (!values.check) writeFileSync(path, text);
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} is stale; regenerate with the same catalogue and reviews`);
}
process.stdout.write(`${Object.keys(active).length}/${leaves.length} leaves enabled; ${report.filter(row => row.status === 'passed').length} newly passed; `
  + `${Object.keys(notableActive).length} more with a notable lane\n`);
