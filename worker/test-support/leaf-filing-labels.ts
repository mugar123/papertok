// The labelled (OpenAlex work, leaf) pairs of the leaf-filing calibration, read
// from the review files in scripts/data, and a check of a calibration dataset's
// labels against them. Node only. How the dataset is made and kept is in
// worker/leaf-filing-calibration.md.
//
//   node worker/test-support/leaf-filing-labels.ts <dataset.json>
//
// A pair is labelled by every sample that holds the work: the topic reviews,
// the leaf samples and source samples of openalex-venue-reviews.json, and its
// `otherSamples` (one of them names no leaf: each of its labels does). A call
// is `on` for on-target, `off` for off-target and `doubt` for an uncertain
// one; two calls on one pair that disagree make it `doubt`, so only an
// undisputed `on` is a positive. Only the leaves of the areas the harvest
// keeps an area lane for count: the dataset holds no others.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllLeafCategories } from '../../src/data/category-taxonomy.ts';
import { AREA_LANE_AREAS } from '../paper-store.ts';

type Label = 'on' | 'off' | 'doubt';
type Labels = Map<string, Record<string, Label>>;
interface Sample {
  works: Array<{ id: string }>;
  labels: Array<{ workId: string; label?: 'on-target' | 'off-target'; uncertain?: true; leaf?: string }>;
}
interface VenueReviews {
  leaves: Record<string, { sample: Sample; sourceSamples?: Sample[] }>;
  otherSamples: Array<Sample & { leaf?: string }>;
}

const bare = (id: string) => id.split('/').pop()!;

/** Every area-lane pair the reviews label, by work. */
export function labelsFromReviews(topicReviews: Record<string, Sample>, venueReviews: VenueReviews): Labels {
  const leaves = getAllLeafCategories();
  const known = new Set(leaves.map(leaf => leaf.id));
  const areaLeaves = new Set(leaves.filter(leaf => AREA_LANE_AREAS.includes(leaf.area)).map(leaf => leaf.id));
  const labels: Labels = new Map();

  const add = (sample: Sample, leaf: string | undefined, where: string) => {
    const sampled = new Set(sample.works.map(work => bare(work.id)));
    const labelled = new Set<string>();
    for (const call of sample.labels) {
      const work = bare(call.workId);
      const pairLeaf = call.leaf ?? leaf;
      const label: Label | undefined = call.uncertain ? 'doubt' : call.label === 'on-target' ? 'on' : call.label === 'off-target' ? 'off' : undefined;
      if (!sampled.has(work) || labelled.has(work) || !label || !pairLeaf || !known.has(pairLeaf)) throw new Error(`${where}: invalid label for ${work}`);
      labelled.add(work);
      if (!areaLeaves.has(pairLeaf)) continue;
      const own = labels.get(work) ?? {};
      own[pairLeaf] = pairLeaf in own && own[pairLeaf] !== label ? 'doubt' : label;
      labels.set(work, own);
    }
    if (labelled.size !== sampled.size) throw new Error(`${where}: label every sampled work`);
  };

  for (const [leaf, review] of Object.entries(topicReviews)) add(review, leaf, `topic review ${leaf}`);
  for (const [leaf, entry] of Object.entries(venueReviews.leaves)) {
    add(entry.sample, leaf, `venue sample ${leaf}`);
    for (const sample of entry.sourceSamples ?? []) add(sample, leaf, `venue source sample ${leaf}`);
  }
  venueReviews.otherSamples.forEach((sample, index) => add(sample, sample.leaf, `other sample ${index}`));
  return labels;
}

/** The dataset's articles whose labels differ from the reviews', and the reviews' pairs it holds no vector for. */
export function compareWithDataset(labels: Labels, dataset: { labelled: Array<{ id: string; labels: Record<string, Label> }> }) {
  const sameLabels = (a: Record<string, Label>, b: Record<string, Label> = {}) => Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([leaf, label]) => b[leaf] === label);
  const inDataset = new Set(dataset.labelled.map(article => article.id));
  const pairs = (own: Record<string, Label>) => Object.keys(own).length;
  return {
    articles: dataset.labelled.length,
    pairs: dataset.labelled.reduce((sum, article) => sum + pairs(article.labels), 0),
    differing: dataset.labelled.filter(article => !sameLabels(article.labels, labels.get(article.id))).map(article => article.id),
    pairsWithoutVector: [...labels].filter(([work]) => !inDataset.has(work)).reduce((sum, [, own]) => sum + pairs(own), 0),
  };
}

function main() {
  const [path] = process.argv.slice(2);
  if (!path) {
    process.stderr.write('Usage: node worker/test-support/leaf-filing-labels.ts <dataset.json>\n');
    process.exit(1);
  }
  const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../scripts/data/${name}`, import.meta.url)), 'utf8'));
  const report = compareWithDataset(labelsFromReviews(read('openalex-topic-reviews.json'), read('openalex-venue-reviews.json')), JSON.parse(readFileSync(path, 'utf8')));
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  if (report.differing.length) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
