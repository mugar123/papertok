// Calibration of LEAF_FILING_RULES (worker/leaf-filing.ts) on labelled journal
// articles. Node only.
//
//   node worker/test-support/calibrate-leaf-filing.ts <dataset.json>
//
// The dataset holds int8 vectors in the stored form (paper-store.ts
// `quantize`, base64), embedded from the text the corpus embeds:
//   { "arxiv": [{ "id", "leaf", "vector" }],          newest arXiv papers whose primary category is the leaf
//     "labelled": [{ "id", "vector", "labels": { "<leaf>": "on" | "off" | "doubt" } }],
//     "areaSamples": [{ "id", "area", "vector" }] }   newest articles of each area lane
// Each leaf with at least 50 arXiv papers gets a centroid, as storeLeafCentroids
// gives one. Each area's labelled articles are split in two with a fixed seed.
// On the calibration half, the rule chosen is the one that files the most
// articles correctly at CALIBRATION_PRECISION or more; the held-out half then
// measures it once. An area gets a rule only when the held-out precision
// reaches REQUIRED_PRECISION over MIN_HELD_OUT_DECIDED filings or more.
//
// An article filed under a leaf is correct when labelled on target for it. It
// is wrong when labelled off target or doubted for it, or when it is unlabelled
// there but on target for another leaf of the area. Otherwise its filing is
// unknown: counted, but outside precision.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllLeafCategories } from '../../src/data/category-taxonomy.ts';
import { type FilingRule, areaCentroids, closestLeaf, evaluateLeafFiling, leafCentroids, ruleFiles } from '../leaf-filing.ts';
import { AREA_LANE_AREAS } from '../paper-store.ts';

type Label = 'on' | 'off' | 'doubt';
export interface CalibrationDataset {
  arxiv: Array<{ id: string; leaf: string; vector: string }>;
  labelled: Array<{ id: string; vector: string; labels: Record<string, Label> }>;
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
export function calibrationSplit<T extends { id: string }>(articles: T[]) {
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

type Closest = ReturnType<typeof closestLeaf>;
interface Article { id: string; labels: Record<string, Label>; positive: boolean; closest: Closest }

type Measured = ReturnType<typeof outcomes>;
type Interval = ReturnType<typeof wilson>;

/** One area's calibration; the measurements are absent where it stopped before them. */
export interface AreaCalibration {
  area: string;
  centroids: string[];
  labelledArticles: number;
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
  arxivHeldOut?: { papers: number; filed: number; correct: number; precision: number | null } | null;
  enabled: boolean;
  reason: string;
}

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

const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);

export function calibrateLeafFiling(dataset: CalibrationDataset): AreaCalibration[] {
  const leafArea = new Map(getAllLeafCategories().map(leaf => [leaf.id, leaf.area]));
  const samples = dataset.arxiv.map(paper => ({ leaf: paper.leaf, vector: vectorOf(paper.vector) }));
  const centroids = leafCentroids(samples);
  return AREA_LANE_AREAS.flatMap((area): AreaCalibration[] => {
    const own = areaCentroids(area, centroids);
    const articles = dataset.labelled.flatMap(paper => {
      const labels = Object.fromEntries(Object.entries(paper.labels).filter(([leaf]) => leafArea.get(leaf) === area));
      return Object.keys(labels).length ? [{ id: paper.id, labels, vector: paper.vector }] : [];
    });
    if (articles.length === 0) return [];
    const perLeaf: Record<string, Record<Label, number>> = {};
    for (const article of articles) {
      for (const [leaf, label] of Object.entries(article.labels)) {
        perLeaf[leaf] ??= { on: 0, off: 0, doubt: 0 };
        perLeaf[leaf][label] += 1;
      }
    }
    const summary = { area, centroids: [...own.keys()], labelledArticles: articles.length, labelsPerLeaf: perLeaf };
    if (own.size < 2) return [{ ...summary, enabled: false, reason: 'fewer than two leaves with a centroid' }];

    const [calibration, heldOut] = calibrationSplit(articles).map(half => half.map(article => ({
      id: article.id,
      labels: article.labels,
      positive: Object.values(article.labels).includes('on'),
      closest: closestLeaf(vectorOf(article.vector), own),
    })));

    let chosen: { rule: FilingRule; measured: Measured } | null = null;
    for (const similarity of SIMILARITIES) {
      for (const margin of MARGINS) {
        const measured = outcomes(calibration, { similarity, margin });
        const decided = measured.correct + measured.wrong;
        if (decided < MIN_CALIBRATION_DECIDED || measured.correct / decided < CALIBRATION_PRECISION) continue;
        const better = !chosen || measured.correct > chosen.measured.correct
          || (measured.correct === chosen.measured.correct && (measured.wrong < chosen.measured.wrong
            || (measured.wrong === chosen.measured.wrong && (margin > chosen.rule.margin
              || (margin === chosen.rule.margin && similarity > chosen.rule.similarity)))));
        if (better) chosen = { rule: { similarity, margin }, measured };
      }
    }
    if (!chosen) return [{ ...summary, split: { calibration: calibration.length, heldOut: heldOut.length }, enabled: false, reason: `no rule reaches ${CALIBRATION_PRECISION} precision on the calibration half over ${MIN_CALIBRATION_DECIDED} decided filings` }];

    const { rule } = chosen;
    const test = outcomes(heldOut, rule);
    const decided = test.correct + test.wrong;
    const precision = ratio(test.correct, decided);
    const enabled = decided >= MIN_HELD_OUT_DECIDED && (precision ?? 0) >= REQUIRED_PRECISION;
    const lane = dataset.areaSamples.filter(paper => paper.area === area).map(paper => closestLeaf(vectorOf(paper.vector), own));
    const laneFiled = lane.filter(closest => ruleFiles(closest, rule)).length;
    const [arxiv] = evaluateLeafFiling(samples, [rule]).filter(row => row.area === area);
    return [{
      ...summary,
      split: { calibration: calibration.length, heldOut: heldOut.length },
      rule,
      calibration: chosen.measured,
      heldOut: {
        ...test,
        precision, precisionInterval: wilson(test.correct, decided),
        recall: ratio(test.correct, test.positives), recallInterval: wilson(test.correct, test.positives),
        shareFiled: ratio(test.filed, test.papers), shareFiledInterval: wilson(test.filed, test.papers),
      },
      areaLaneSample: { papers: lane.length, filed: laneFiled, share: ratio(laneFiled, lane.length), interval: wilson(laneFiled, lane.length) },
      arxivHeldOut: arxiv ? { papers: arxiv.papers, filed: arxiv.filed, correct: arxiv.correct, precision: ratio(arxiv.correct, arxiv.filed) } : null,
      enabled,
      reason: enabled ? `held-out precision ${precision} over ${decided} decided filings`
        : decided < MIN_HELD_OUT_DECIDED ? `${decided} decided held-out filings, under ${MIN_HELD_OUT_DECIDED}` : `held-out precision ${precision}, under ${REQUIRED_PRECISION}`,
    }];
  });
}

function main() {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('Usage: node worker/test-support/calibrate-leaf-filing.ts <dataset.json>\n');
    process.exit(1);
  }
  const dataset = JSON.parse(readFileSync(path, 'utf8')) as CalibrationDataset;
  process.stdout.write(`${JSON.stringify(calibrateLeafFiling(dataset), null, 1)}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
