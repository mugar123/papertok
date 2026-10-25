// Calibration of LEAF_FILING_RULES (worker/leaf-filing.ts) on labelled journal
// articles. Node only. The evidence and how the dataset was made are in
// worker/leaf-filing-calibration.md.
//
//   node worker/test-support/calibrate-leaf-filing.ts <dataset.json> [held-out.json]
//
// The dataset holds vectors in the stored form (paper-store.ts `quantize`, as
// base64), embedded from the text the corpus embeds:
//   { "arxiv": [{ "id", "leaf", "vector" }],          recent arXiv papers whose primary category is the leaf
//     "labelled": [{ "id", "vector", "labels": { "<leaf>": "on" | "off" | "doubt" }, "arxivIds"? }],
//     "areaSamples": [{ "id", "area", "vector" }] }   recent articles of each area lane
// Each leaf with at least 50 arXiv papers gets a centroid, as storeLeafCentroids
// gives one. A labelled article whose OpenAlex record names one of those arXiv
// papers as its preprint (`arxivIds`) is left out: its own preprint would be in
// the centroid it is scored against, and in the corpus that preprint's leaf
// already holds it, so similarity never files it. Each area's other labelled
// articles are split in two with a fixed seed.
// On the calibration half, the chosen rule is the one that files the most
// articles correctly at CALIBRATION_PRECISION or more; the held-out half then
// measures it once. An area gets a rule only when its held-out precision
// reaches REQUIRED_PRECISION over MIN_HELD_OUT_DECIDED filings or more. Given a
// second path, the script writes there the centroids and held-out articles of
// the areas that get a rule: the fixture leaf-filing.test.ts files them with.
//
// An article filed under a leaf is correct when labelled on target for it. It
// is wrong when labelled off target or doubted for it, or when it is unlabelled
// there but on target for another leaf of the area. Otherwise its filing is
// unknown: counted, but outside precision.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllLeafCategories } from '../../src/data/category-taxonomy.ts';
import { type FilingRule, areaCentroids, closestLeaf, leafCentroids, ruleFiles } from '../leaf-filing.ts';
import { AREA_LANE_AREAS } from '../paper-store.ts';

type Label = 'on' | 'off' | 'doubt';
interface LabelledArticle { id: string; vector: string; labels: Record<string, Label>; arxivIds?: string[] }
interface CalibrationDataset {
  arxiv: Array<{ id: string; leaf: string; vector: string }>;
  labelled: LabelledArticle[];
  areaSamples: Array<{ id: string; area: string; vector: string }>;
}

const SEED = 107;
const CALIBRATION_PRECISION = 0.95;
const MIN_CALIBRATION_DECIDED = 20;
const REQUIRED_PRECISION = 0.9;
const MIN_HELD_OUT_DECIDED = 30;
const SIMILARITIES = Array.from({ length: 66 }, (_, index) => Math.round((0.3 + index * 0.01) * 100) / 100);
const MARGINS = Array.from({ length: 41 }, (_, index) => Math.round(index * 0.005 * 1000) / 1000);

const vectorOf = (base64: string) => new Int8Array(Buffer.from(base64, 'base64'));

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One area's articles in two halves, calibration then held out: ordered by id, shuffled with the fixed seed. */
function calibrationSplit<T extends { id: string }>(articles: T[]) {
  const random = mulberry32(SEED);
  const shuffled = [...articles].sort((a, b) => a.id.localeCompare(b.id));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  const half = Math.ceil(shuffled.length / 2);
  return [shuffled.slice(0, half), shuffled.slice(half)];
}

/** The Wilson score interval at 95 %, rounded to three places; null without trials. */
export function wilson(successes: number, trials: number) {
  if (trials === 0) return null;
  const z = 1.959964;
  const p = successes / trials;
  const centre = (p + (z * z) / (2 * trials)) / (1 + (z * z) / trials);
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / (1 + (z * z) / trials);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

/** The labelled articles, without those whose preprint is one of the arXiv papers. */
function scoredArticles(dataset: CalibrationDataset) {
  const sampled = new Set(dataset.arxiv.map(paper => paper.id));
  return dataset.labelled.filter(article => !article.arxivIds?.some(id => sampled.has(id)));
}

/** The articles with a label on a leaf of the area, with only those labels. */
function areaArticles(labelled: LabelledArticle[], area: string) {
  const leafArea = new Map(getAllLeafCategories().map(leaf => [leaf.id, leaf.area]));
  return labelled.flatMap(article => {
    const labels = Object.fromEntries(Object.entries(article.labels).filter(([leaf]) => leafArea.get(leaf) === area));
    return Object.keys(labels).length ? [{ ...article, labels }] : [];
  });
}

interface Article { labels: Record<string, Label>; positive: boolean; closest: ReturnType<typeof closestLeaf> }

function outcomes(articles: Article[], rule: FilingRule) {
  let filed = 0;
  let correct = 0;
  let wrong = 0;
  for (const article of articles) {
    if (!ruleFiles(article.closest, rule)) continue;
    filed += 1;
    const label = article.labels[article.closest!.leaf];
    if (label === 'on') correct += 1;
    else if (label || article.positive) wrong += 1;
  }
  return { papers: articles.length, positives: articles.filter(article => article.positive).length, filed, correct, wrong, unknown: filed - correct - wrong };
}

// Most correct filings first; then fewest wrong, the wider margin, the higher similarity.
const rank = (measured: Measured, rule: FilingRule) => [measured.correct, -measured.wrong, rule.margin, rule.similarity];
const outranks = (a: number[], b: number[]) => {
  const index = a.findIndex((value, at) => value !== b[at]);
  return index >= 0 && a[index] > b[index];
};

const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);

type Measured = ReturnType<typeof outcomes>;
type Interval = ReturnType<typeof wilson>;
/** One area's calibration; the measurements are absent where it stopped before them. */
interface AreaCalibration {
  area: string;
  centroids: string[];
  labelledArticles: number;
  leftOutWithCentroidPreprint: number;
  labelsPerLeaf: Record<string, Record<Label, number>>;
  split?: { calibration: number; heldOut: number };
  rule?: FilingRule;
  calibration?: Measured;
  heldOut?: Measured & {
    precision: number | null; precisionInterval: Interval;
    recall: number | null; recallInterval: Interval;
    shareFiled: number | null; shareFiledInterval: Interval;
  };
  areaLaneSample?: { papers: number; filed: number; share: number | null; interval: Interval };
  enabled: boolean;
  reason: string;
}

export function calibrateLeafFiling(dataset: CalibrationDataset): AreaCalibration[] {
  const centroids = leafCentroids(dataset.arxiv.map(paper => ({ leaf: paper.leaf, vector: vectorOf(paper.vector) })));
  const scored = scoredArticles(dataset);
  return AREA_LANE_AREAS.flatMap((area): AreaCalibration[] => {
    const own = areaCentroids(area, centroids);
    const articles = areaArticles(scored, area);
    if (articles.length === 0) return [];
    const labelsPerLeaf: Record<string, Record<Label, number>> = {};
    for (const article of articles) {
      for (const [leaf, label] of Object.entries(article.labels)) {
        labelsPerLeaf[leaf] ??= { on: 0, off: 0, doubt: 0 };
        labelsPerLeaf[leaf][label] += 1;
      }
    }
    const leftOutWithCentroidPreprint = areaArticles(dataset.labelled, area).length - articles.length;
    const summary = { area, centroids: [...own.keys()], labelledArticles: articles.length, leftOutWithCentroidPreprint, labelsPerLeaf };
    if (own.size < 2) return [{ ...summary, enabled: false, reason: 'fewer than two leaves with a centroid' }];

    const [calibration, heldOut] = calibrationSplit(articles).map(half => half.map(article => ({
      labels: article.labels,
      positive: Object.values(article.labels).includes('on'),
      closest: closestLeaf(vectorOf(article.vector), own),
    })));
    const split = { calibration: calibration.length, heldOut: heldOut.length };

    let chosen: { rule: FilingRule; measured: Measured } | null = null;
    for (const similarity of SIMILARITIES) {
      for (const margin of MARGINS) {
        const rule = { similarity, margin };
        const measured = outcomes(calibration, rule);
        const decided = measured.correct + measured.wrong;
        if (decided < MIN_CALIBRATION_DECIDED || measured.correct / decided < CALIBRATION_PRECISION) continue;
        if (!chosen || outranks(rank(measured, rule), rank(chosen.measured, chosen.rule))) chosen = { rule, measured };
      }
    }
    if (!chosen) return [{ ...summary, split, enabled: false, reason: `no rule reaches ${CALIBRATION_PRECISION} precision on the calibration half over ${MIN_CALIBRATION_DECIDED} decided filings` }];

    const { rule } = chosen;
    const test = outcomes(heldOut, rule);
    const decided = test.correct + test.wrong;
    const precision = ratio(test.correct, decided);
    const enabled = decided >= MIN_HELD_OUT_DECIDED && test.correct / decided >= REQUIRED_PRECISION;
    const lane = dataset.areaSamples.filter(paper => paper.area === area);
    const laneFiled = lane.filter(paper => ruleFiles(closestLeaf(vectorOf(paper.vector), own), rule)).length;
    return [{
      ...summary,
      split,
      rule,
      calibration: chosen.measured,
      heldOut: {
        ...test,
        precision, precisionInterval: wilson(test.correct, decided),
        recall: ratio(test.correct, test.positives), recallInterval: wilson(test.correct, test.positives),
        shareFiled: ratio(test.filed, test.papers), shareFiledInterval: wilson(test.filed, test.papers),
      },
      areaLaneSample: { papers: lane.length, filed: laneFiled, share: ratio(laneFiled, lane.length), interval: wilson(laneFiled, lane.length) },
      enabled,
      reason: enabled ? `held-out precision ${precision} over ${decided} decided filings`
        : decided < MIN_HELD_OUT_DECIDED ? `${decided} decided held-out filings, under ${MIN_HELD_OUT_DECIDED}` : `held-out precision ${test.correct}/${decided}, under ${REQUIRED_PRECISION}`,
    }];
  });
}

/** The centroids and held-out articles of these areas, one article a line. */
function heldOutFixture(dataset: CalibrationDataset, areas: string[]) {
  const centroids = leafCentroids(dataset.arxiv.map(paper => ({ leaf: paper.leaf, vector: vectorOf(paper.vector) })));
  const entries = areas.map(area => {
    const own = Object.fromEntries([...areaCentroids(area, centroids)].map(([leaf, vector]) => [leaf, Buffer.from(vector.buffer).toString('base64')]));
    const [, heldOut] = calibrationSplit(areaArticles(scoredArticles(dataset), area));
    const articles = heldOut.sort((a, b) => a.id.localeCompare(b.id)).map(({ id, labels, vector }) => JSON.stringify({ id, labels, vector }));
    return `${JSON.stringify(area)}: {\n"centroids": ${JSON.stringify(own)},\n"articles": [\n${articles.join(',\n')}\n]}`;
  });
  return `{\n${entries.join(',\n')}\n}\n`;
}

function main() {
  const [path, fixturePath] = process.argv.slice(2);
  if (!path) {
    process.stderr.write('Usage: node worker/test-support/calibrate-leaf-filing.ts <dataset.json> [held-out.json]\n');
    process.exit(1);
  }
  const dataset = JSON.parse(readFileSync(path, 'utf8')) as CalibrationDataset;
  const report = calibrateLeafFiling(dataset);
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  if (fixturePath) writeFileSync(fixturePath, heldOutFixture(dataset, report.filter(row => row.enabled).map(row => row.area)));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
