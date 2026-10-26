import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';
import { europePmcLabelQuery } from '../src/services/domain-source-records.ts';

// The medicine and biology leaves whose notable lane also lists Europe PMC's
// most-cited records of each year that name the leaf (`europepmc-notable` in
// worker/paper-sources.ts). Each leaf's evidence is a labelled sample: the 15
// most-cited records with an abstract of the ten completed years before the
// capture, asked with the leaf's label query.
// scripts/README-europepmc-notable.md describes the inputs.

interface Work { id: string; source: string; title: string; pubYear: string; citedByCount: number }
interface Sample {
  capturedAt: string;
  // The search URL as sent.
  query: string;
  // The response's `hitCount`: every record the query matched.
  hitCount: number;
  works: Work[];
  // `uncertain` marks a call the labeller doubted; it counts as a miss.
  labels: Array<{ workId: string; label?: 'on-target' | 'off-target'; uncertain?: true }>;
}
interface Reviews { leaves: Record<string, Sample> }

const leaves = getAllLeafCategories();
// The gate of the topic and venue lanes: one page of 15, at least two thirds
// on target without doubt.
const minimumSample = 15;
const minimumPrecision = 2 / 3;
// The years the notable lanes list (worker/paper-store.ts `NOTABLE_YEARS`),
// 100 records a year (worker/paper-sources.ts `NOTABLE_PER_YEAR`). A label
// that matches fewer records than the listing takes would list nearly all of
// them, uncited ones included, of which the sample's head says little.
const notableYears = 10;
const minimumPopulation = notableYears * 100;
const EUROPE_PMC_SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

function checkSample(leaf: string, value: unknown) {
  const sample = value as Sample | null;
  const invalid = (reason: string): never => { throw new Error(`${leaf}: ${reason}`); };
  if (!/^(?:med|bio)\./.test(leaf)) invalid('only a medicine or biology leaf takes a Europe PMC sample');
  if (!leaves.some(item => item.id === leaf)) invalid('not a taxonomy leaf');
  if (!sample || typeof sample.query !== 'string' || !Array.isArray(sample.works) || !Array.isArray(sample.labels)) invalid('missing sample');
  const capturedAt = Date.parse(sample!.capturedAt);
  if (!Number.isFinite(capturedAt)) invalid('missing capture date');
  const year = new Date(capturedAt).getUTCFullYear();
  const [first, last] = [year - notableYears, year - 1];
  const query = new URL(sample!.query);
  const expected: Record<string, string> = {
    query: `${europePmcLabelQuery([leaf])} AND PUB_YEAR:[${first} TO ${last}] AND HAS_ABSTRACT:y sort_cited:y`,
    format: 'json', resultType: 'core', pageSize: String(minimumSample), page: '1',
  };
  if (`${query.origin}${query.pathname}` !== EUROPE_PMC_SEARCH || query.username || query.password
    || [...query.searchParams.keys()].length !== Object.keys(expected).length
    || Object.entries(expected).some(([name, wanted]) => query.searchParams.getAll(name).length !== 1 || query.searchParams.get(name) !== wanted)) {
    invalid("sample must be the most-cited page of 15 with an abstract of the leaf's label query over the ten completed years before its capture");
  }

  if (sample!.works.length > minimumSample) invalid('a sample is one page of 15');
  if (!Number.isInteger(sample!.hitCount) || sample!.hitCount < sample!.works.length) invalid('missing or impossible hitCount');
  const workIds = new Set<string>();
  let previous = Infinity;
  for (const work of sample!.works) {
    const id = String(work?.id ?? '');
    const published = Number(work?.pubYear);
    const cited = work?.citedByCount;
    if (!id || workIds.has(`${work.source}:${id}`) || !/^[A-Z]{2,4}$/.test(String(work.source))
      || typeof work.title !== 'string' || !work.title.trim()
      || !Number.isInteger(published) || published < first || published > last
      || !Number.isInteger(cited) || cited < 0 || cited > previous) invalid(`invalid notable record: ${work?.source}:${id}`);
    workIds.add(`${work.source}:${id}`);
    previous = cited;
  }
  const idOf = new Map(sample!.works.map(work => [String(work.id), `${work.source}:${work.id}`]));
  const labelled = new Set<string>();
  for (const label of sample!.labels) {
    const key = idOf.get(String(label?.workId));
    if (!key || labelled.has(key) || ![undefined, true].includes(label.uncertain)
      || (label.label === undefined ? !label.uncertain : !['on-target', 'off-target'].includes(label.label))) {
      invalid(`invalid or duplicate label: ${label?.workId}`);
    }
    labelled.add(key!);
  }
  if (idOf.size !== workIds.size) invalid('two sampled records share an id');
  if (labelled.size !== workIds.size) invalid('label every sampled record; do not omit misses');
  // A paper two journals publish (a joint guideline) is two records and one
  // work for its readers (worker/paper-store.ts merges them by title): it
  // counts once, on target only when every copy is.
  const titleOf = (work: Work) => work.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const hit = new Map(sample!.labels.map(label => [String(label.workId), label.label === 'on-target' && !label.uncertain]));
  const byTitle = new Map<string, boolean>();
  for (const work of sample!.works) byTitle.set(titleOf(work), (byTitle.get(titleOf(work)) ?? true) && hit.get(String(work.id))!);
  const onTarget = [...byTitle.values()].filter(Boolean).length;
  const sampleSize = byTitle.size;
  const status = sampleSize < minimumSample ? 'insufficient-sample'
    : sample!.hitCount < minimumPopulation ? 'small-population'
      : onTarget / sampleSize >= minimumPrecision ? 'passed' : 'rejected';
  return { status, sampleSize, onTarget, precision: sampleSize ? onTarget / sampleSize : null, hitCount: sample!.hitCount };
}

const { values } = parseArgs({ options: {
  reviews: { type: 'string', default: fileURLToPath(new URL('./data/europepmc-notable-reviews.json', import.meta.url)) },
  report: { type: 'string', default: fileURLToPath(new URL('./data/europepmc-notable-coverage.json', import.meta.url)) },
  out: { type: 'string', default: fileURLToPath(new URL('../worker/europepmc-notable-leaves.generated.ts', import.meta.url)) },
  check: { type: 'boolean', default: false },
} });
const reviews = JSON.parse(readFileSync(values.reviews!, 'utf8')) as Reviews;
if (!reviews?.leaves || typeof reviews.leaves !== 'object') throw new Error('Reviews must hold the samples keyed by taxonomy leaf ID');
const report = Object.keys(reviews.leaves).sort().map(leaf => ({ leaf, ...checkSample(leaf, reviews.leaves[leaf]) }));
const admitted = report.filter(row => row.status === 'passed').map(row => row.leaf);
const output = [
  '// Generated by scripts/generate-europepmc-notable-leaves.ts from scripts/data/europepmc-notable-reviews.json; do not edit.',
  '// The leaves whose notable lane also lists Europe PMC\'s most-cited records of each year: their sample passed.',
  'export const EUROPE_PMC_NOTABLE_LEAVES: readonly string[] = Object.freeze([',
  ...admitted.map(leaf => `  '${leaf}',`),
  ']);', '',
].join('\n');
const files = [[resolve(values.out!), output], [resolve(values.report!), `${JSON.stringify(report, null, 2)}\n`]];
for (const [path, text] of files) {
  if (!values.check) writeFileSync(path, text);
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} is stale; regenerate with the same reviews`);
}
process.stdout.write(`${admitted.length} of ${report.length} sampled leaves list Europe PMC's most-cited records\n`);
