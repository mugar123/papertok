import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';

// The arXiv categories whose notable lane lists ADS's most-cited papers that
// arXiv files under the category first (`ads-notable` in
// worker/paper-sources.ts). ADS's `arxiv_class` names every class a paper is
// listed in, so a small class's most-cited papers are mostly cross-listed
// from a neighbour. Each leaf's evidence is two labelled samples of the ten
// completed years before the capture: the 15 most cited filed under the leaf
// first, which the gate reads, and the 15 most cited with the class anywhere.
// scripts/README-ads-notable.md describes the inputs.

interface Work { bibcode: string; title: string; year: string; citationCount: number; arxivClass: string[] }
interface Sample {
  capturedAt: string;
  // The search URL as sent; the token travels in a header.
  query: string;
  // The response's `numFound`: every record the query matched.
  numFound: number;
  works: Work[];
  // `uncertain` marks a call the labeller doubted; it counts as a miss.
  labels: Array<{ bibcode: string; label?: 'on-target' | 'off-target'; uncertain?: true }>;
}
interface Reviews { leaves: Record<string, { listed: Sample; ownClass: Sample }> }

const leaves = getAllLeafCategories();
// The gate of the topic, venue and Europe PMC lanes: one page of 15, at least
// two thirds on target without doubt.
const minimumSample = 15;
const minimumPrecision = 2 / 3;
// The years the notable lanes list (worker/paper-store.ts `NOTABLE_YEARS`).
const notableYears = 10;
const ADS_SEARCH = 'https://api.adsabs.harvard.edu/v1/search/query';
// The labellers read the title and the abstract.
const FIELDS = 'bibcode,title,abstract,year,pubdate,doi,identifier,arxiv_class,citation_count,doctype,pub,property';
// The papers filed under the leaf first are taken from ADS's largest page,
// most cited first, as the listing takes them.
const RANKED_ROWS = 2000;

function checkSample(leaf: string, value: unknown, ownClass: boolean) {
  const sample = value as Sample | null;
  const invalid = (reason: string): never => { throw new Error(`${leaf} (${ownClass ? 'ownClass' : 'listed'}): ${reason}`); };
  if (!sample || typeof sample.query !== 'string' || !Array.isArray(sample.works) || !Array.isArray(sample.labels)) invalid('missing sample');
  const capturedAt = Date.parse(sample!.capturedAt);
  if (!Number.isFinite(capturedAt)) invalid('missing capture date');
  const year = new Date(capturedAt).getUTCFullYear();
  const [first, last] = [year - notableYears, year - 1];
  const query = new URL(sample!.query);
  const expected: Record<string, string> = {
    q: `arxiv_class:"${leaf}" year:${first}-${last} doctype:(article OR eprint OR inproceedings)`,
    fl: FIELDS, rows: String(ownClass ? RANKED_ROWS : minimumSample), start: '0', sort: 'citation_count desc',
  };
  if (`${query.origin}${query.pathname}` !== ADS_SEARCH || query.username || query.password
    || [...query.searchParams.keys()].length !== Object.keys(expected).length
    || Object.entries(expected).some(([name, wanted]) => query.searchParams.getAll(name).length !== 1 || query.searchParams.get(name) !== wanted)) {
    invalid("sample must be the most-cited page of the leaf's ADS query over the ten completed years before its capture");
  }

  if (sample!.works.length > minimumSample) invalid('a sample is one page of 15');
  if (!Number.isInteger(sample!.numFound) || sample!.numFound < sample!.works.length) invalid('missing or impossible numFound');
  const bibcodes = new Set<string>();
  let previous = Infinity;
  for (const work of sample!.works) {
    const bibcode = String(work?.bibcode ?? '');
    const published = Number(work?.year);
    const cited = work?.citationCount;
    const classes = Array.isArray(work?.arxivClass) ? work.arxivClass : [];
    if (!bibcode || bibcodes.has(bibcode) || typeof work.title !== 'string' || !work.title.trim()
      || !Number.isInteger(published) || published < first || published > last
      || !Number.isInteger(cited) || cited < 0 || cited > previous
      || !classes.includes(leaf) || (ownClass && classes[0] !== leaf)) invalid(`invalid notable record: ${bibcode}`);
    bibcodes.add(bibcode);
    previous = cited;
  }
  const labelled = new Set<string>();
  for (const label of sample!.labels) {
    const bibcode = String(label?.bibcode ?? '');
    if (!bibcodes.has(bibcode) || labelled.has(bibcode) || ![undefined, true].includes(label.uncertain)
      || (label.label === undefined ? !label.uncertain : !['on-target', 'off-target'].includes(label.label))) {
      invalid(`invalid or duplicate label: ${bibcode}`);
    }
    labelled.add(bibcode);
  }
  if (labelled.size !== bibcodes.size) invalid('label every sampled record; do not omit misses');
  const onTarget = sample!.labels.filter(label => label.label === 'on-target' && !label.uncertain).length;
  const sampleSize = bibcodes.size;
  const status = sampleSize < minimumSample ? 'insufficient-sample' : onTarget / sampleSize >= minimumPrecision ? 'passed' : 'rejected';
  return { status, sampleSize, onTarget, precision: sampleSize ? onTarget / sampleSize : null, numFound: sample!.numFound };
}

function checkLeaf(leaf: string, value: unknown) {
  if (!leaves.some(item => item.id === leaf)) throw new Error(`${leaf}: not a taxonomy leaf`);
  const samples = value as Reviews['leaves'][string] | null;
  return { leaf, listed: checkSample(leaf, samples?.listed, false), ownClass: checkSample(leaf, samples?.ownClass, true) };
}

const { values } = parseArgs({ options: {
  reviews: { type: 'string', default: fileURLToPath(new URL('./data/ads-notable-reviews.json', import.meta.url)) },
  report: { type: 'string', default: fileURLToPath(new URL('./data/ads-notable-coverage.json', import.meta.url)) },
  out: { type: 'string', default: fileURLToPath(new URL('../worker/ads-notable-leaves.generated.ts', import.meta.url)) },
  check: { type: 'boolean', default: false },
} });
const reviews = JSON.parse(readFileSync(values.reviews!, 'utf8')) as Reviews;
if (!reviews?.leaves || typeof reviews.leaves !== 'object') throw new Error('Reviews must hold the samples keyed by taxonomy leaf ID');
const report = Object.keys(reviews.leaves).sort().map(leaf => checkLeaf(leaf, reviews.leaves[leaf]));
const admitted = report.filter(row => row.ownClass.status === 'passed').map(row => row.leaf);
const output = [
  '// Generated by scripts/generate-ads-notable-leaves.ts from scripts/data/ads-notable-reviews.json; do not edit.',
  '// The arXiv categories whose ADS notable listing keeps the papers arXiv files under them first: their sample passed.',
  'export const ADS_NOTABLE_OWN_CLASS_LEAVES: readonly string[] = Object.freeze([',
  ...admitted.map(leaf => `  '${leaf}',`),
  ']);', '',
].join('\n');
const files = [[resolve(values.out!), output], [resolve(values.report!), `${JSON.stringify(report, null, 2)}\n`]];
for (const [path, text] of files) {
  if (!values.check) writeFileSync(path, text);
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} is stale; regenerate with the same reviews`);
}
process.stdout.write(`${admitted.length} of ${report.length} sampled leaves list ADS's most-cited papers filed under them first\n`);
