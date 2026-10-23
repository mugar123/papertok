import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAllLeafCategories } from '../src/data/categoryTaxonomy.ts';
import { openAlexFilterForArea } from '../src/data/openAlexAreas.ts';

interface Topic {
  id: string; display_name: string; keywords?: string[];
  field?: { id: string }; subfield?: { id: string };
}
interface Review {
  capturedAt: string;
  query: string;
  // Only the fields checked below; the query's has_abstract:true proves the
  // abstracts, and the work IDs lead back to the full records.
  works: Array<{ id: string; title: string; type: string; publication_date: string; primary_topic: { id: string } }>;
  // `uncertain` marks a call the labeller doubted; it counts as a miss. A
  // doubted call has no label when the labeller leaned neither way.
  labels: Array<{ workId: string; label?: 'on-target' | 'off-target'; uncertain?: true }>;
}

const leaves = getAllLeafCategories();
// The sample is one page of the 15 newest articles (PAP-99); a leaf with fewer
// in the feed's window cannot pass.
const minimumSample = 15;
// PR #236's lowest accepted profile was 66.0%; use the next exact fraction.
const minimumPrecision = 2 / 3;
const baseline = JSON.parse(readFileSync(new URL('./data/openalex-leaf-topics-baseline.json', import.meta.url), 'utf8')) as {
  topics: Record<string, string[]>;
};
const stopWords = new Set(words('and of the general science engineering physics applied theory theoretical applications'));

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

function topicKey(value: string) {
  return String(value || '').split('/').pop()!;
}

function checkReview(leaf: string, value: unknown) {
  const review = value as Review | null;
  const invalid = (reason: string): never => { throw new Error(`${leaf}: ${reason}`); };
  if (!review || typeof review.query !== 'string') invalid('missing review');
  const capturedAt = Date.parse(review!.capturedAt);
  if (!Number.isFinite(capturedAt)) invalid('missing capture date');
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  const firstDay = day(capturedAt - 90 * 86_400_000);
  const lastDay = day(capturedAt);
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
    'has_abstract:true', 'is_retracted:false', 'primary_location.source.is_core:true',
  ];
  const allowedParams = new Set(['filter', 'sort', 'page', 'per-page', 'mailto', 'select']);
  if (query.origin !== 'https://api.openalex.org' || query.pathname !== '/works'
    || query.username || query.password
    || [...query.searchParams.keys()].some(key => !allowedParams.has(key) || query.searchParams.getAll(key).length !== 1)
    || query.searchParams.get('sort') !== 'publication_date:desc'
    || query.searchParams.get('page') !== '1' || query.searchParams.get('per-page') !== String(minimumSample)
    || filters.length !== required.length || required.some(filter => !filters.includes(filter))) {
    invalid('sample must use the anonymous, newest-first feed query, not text or subfield search');
  }
  if (!Array.isArray(review!.works) || review!.works.length > minimumSample || !Array.isArray(review!.labels)) invalid('invalid sample or labels');
  const workIds = new Set<string>();
  let previousDate = lastDay;
  for (const work of review!.works) {
    const id = topicKey(work?.id);
    if (!/^W\d+$/.test(id) || workIds.has(id) || work.type !== 'article'
      || typeof work.title !== 'string' || !work.title.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(work.publication_date)
      || work.publication_date < firstDay || work.publication_date > previousDate
      || !topicIds.includes(topicKey(work.primary_topic?.id))) invalid(`invalid recent article: ${id}`);
    workIds.add(id);
    previousDate = work.publication_date;
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

const { values } = parseArgs({ options: {
  catalogue: { type: 'string', default: fileURLToPath(new URL('./data/openalex-topic-catalogue.json', import.meta.url)) },
  reviews: { type: 'string', default: fileURLToPath(new URL('./data/openalex-topic-reviews.json', import.meta.url)) },
  report: { type: 'string', default: fileURLToPath(new URL('./data/openalex-leaf-topics-coverage.json', import.meta.url)) },
  out: { type: 'string', default: fileURLToPath(new URL('../src/data/openAlexLeafTopics.generated.ts', import.meta.url)) },
  check: { type: 'boolean', default: false },
} });
const catalogue = readCatalogue(readJson(values.catalogue!));
const reviews = readJson(values.reviews!) as Record<string, unknown>;
if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)) throw new Error('Reviews must be keyed by taxonomy leaf ID');
for (const leaf of Object.keys(reviews)) {
  if (!leaves.some(item => item.id === leaf) || baseline.topics[leaf]) throw new Error(`Review must name a new taxonomy leaf: ${leaf}`);
}
const active = { ...baseline.topics };
const report = leaves.map(leaf => {
  const row = { leaf: leaf.id, label: leaf.label };
  if (baseline.topics[leaf.id]) return { ...row, topicIds: baseline.topics[leaf.id], status: 'inherited' };
  if (Object.hasOwn(reviews, leaf.id)) {
    const { onTargetTopics, ...result } = checkReview(leaf.id, reviews[leaf.id]);
    if (result.status === 'passed') active[leaf.id] = onTargetTopics;
    return { ...row, ...result };
  }
  const topicIds = candidatesForLeaf(leaf, catalogue);
  return { ...row, topicIds, status: topicIds.length ? 'not-reviewed' : catalogue.length ? 'no-candidates' : 'no-catalogue' };
});
const output = [
  '// Generated by scripts/generate-openalex-leaf-topics.ts; do not edit.',
  'export const OPENALEX_LEAF_TOPICS: Readonly<Record<string, readonly string[]>> = Object.freeze({',
  ...Object.keys(active).sort().map(leaf => `  '${leaf}': [${active[leaf].map(id => `'${id}'`).join(', ')}],`),
  '});', '',
].join('\n');
const files = [[resolve(values.out!), output], [resolve(values.report!), `${JSON.stringify(report, null, 2)}\n`]];
for (const [path, text] of files) {
  if (!values.check) writeFileSync(path, text);
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} is stale; regenerate with the same catalogue and reviews`);
}
process.stdout.write(`${Object.keys(active).length}/${leaves.length} leaves enabled; ${report.filter(row => row.status === 'passed').length} newly passed\n`);
