import type { StoreEnv } from './paper-store.ts';

import { getAllLeafCategories } from '../src/data/categoryTaxonomy.ts';
import { isArxivCategory } from '../src/services/arxivRecords.ts';
import { AREA_LANE_AREAS, areaLane, cosine, database, quantize, readVector } from './paper-store.ts';

// The journal articles an area's lane brings in (paper-sources.ts
// `openalex-areas`) say which area they belong to, not which leaf. One is
// filed under a leaf when its vector clearly sits with that leaf's arXiv
// papers, whose categories their authors chose; otherwise it stays at area
// level, shown to the readers of every leaf of the area.

/**
 * A paper is filed under its closest leaf when its cosine similarity to the
 * leaf's centroid reaches `similarity` and beats the next leaf's by `margin`.
 */
export interface FilingRule { similarity: number; margin: number }

/**
 * Each area's rule, set by calibration (test-support/evaluate-leaf-filing.ts).
 * None has been calibrated: no area has a rule, so no journal article is
 * filed under a leaf and every one stays at area level.
 */
export const LEAF_FILING_RULES: Readonly<Record<string, FilingRule>> = Object.freeze({});

// A leaf's centroid is the mean of its newest arXiv papers with a vector. A
// leaf with fewer than MIN_CENTROID_PAPERS has none, and nothing is filed
// under it: a quiet category's few papers would make a centroid of a handful
// of topics. The newest 500 bound what the busiest categories read each night.
const CENTROID_PAPERS = 500;
const MIN_CENTROID_PAPERS = 50;
// Leaves read per D1 call: each answers up to CENTROID_PAPERS vectors.
const CENTROID_LEAVES_PER_CALL = 10;

const LEAVES = getAllLeafCategories();
const leavesOf = (area: string) => LEAVES.filter(leaf => leaf.area === area).map(leaf => leaf.id);

/** The mean direction of these vectors, in the stored form (`quantize`). */
export function centroidOf(vectors: Int8Array[]) {
  const sum = new Array<number>(vectors[0]?.length ?? 0).fill(0);
  for (const vector of vectors) {
    const norm = Math.hypot(...vector) || 1;
    vector.forEach((value, index) => { sum[index] += value / norm; });
  }
  return quantize(sum);
}

/** The closest centroid's leaf and similarity, and its lead over the next; null with fewer than two leaves to tell apart. */
export function closestLeaf(vector: Int8Array, centroids: ReadonlyMap<string, Int8Array>) {
  if (centroids.size < 2) return null;
  let leaf = '';
  let best = -Infinity;
  let next = -Infinity;
  for (const [candidate, centroid] of centroids) {
    const similarity = cosine(vector, centroid);
    if (similarity > best) {
      next = best;
      best = similarity;
      leaf = candidate;
    } else if (similarity > next) next = similarity;
  }
  return { leaf, similarity: best, margin: best - next };
}

/** Whether the rule files a paper whose closest leaf this is. */
export const ruleFiles = (closest: ReturnType<typeof closestLeaf>, rule: FilingRule) => Boolean(closest && closest.similarity >= rule.similarity && closest.margin >= rule.margin);

/**
 * Recomputes the centroid of every leaf of the areas with a lane from its
 * newest arXiv papers with a vector, those whose primary category it is, and
 * stores them in place of the last run's. Returns how many leaves have one.
 */
export async function storeLeafCentroids(env: StoreEnv, now = Date.now()) {
  const db = database(env);
  // A leaf arXiv has no category for (mechanical, civil and chemical
  // engineering) is never an arXiv paper's primary category: it has no centroid.
  const leaves = AREA_LANE_AREAS.flatMap(leavesOf).filter(isArxivCategory);
  const centroids: Array<{ leaf: string; vector: Int8Array; papers: number }> = [];
  for (let start = 0; start < leaves.length; start += CENTROID_LEAVES_PER_CALL) {
    const chunk = leaves.slice(start, start + CENTROID_LEAVES_PER_CALL);
    const answers = await db.batch<{ embedding: unknown }>(chunk.map(leaf => db.prepare(`SELECT v.embedding FROM work_lanes l
      JOIN works w ON w.id = l.work_id
      JOIN work_vectors v ON v.work_id = l.work_id
      WHERE l.lane = ?1 AND w.paper ->> 'primaryCategory' = ?1 AND w.paper ->> 'arxivId' IS NOT NULL
      ORDER BY l.published DESC LIMIT ?2`).bind(leaf, CENTROID_PAPERS)));
    answers.forEach(({ results }, index) => {
      if (results.length < MIN_CENTROID_PAPERS) return;
      centroids.push({ leaf: chunk[index], vector: centroidOf(results.map(row => readVector(row.embedding))), papers: results.length });
    });
  }
  const computedAt = new Date(now).toISOString();
  const statements = [db.prepare('DELETE FROM leaf_centroids')];
  // Four parameters a row, under D1's hundred per statement.
  for (let start = 0; start < centroids.length; start += 25) {
    const chunk = centroids.slice(start, start + 25);
    statements.push(db.prepare(`INSERT INTO leaf_centroids (leaf, embedding, papers, computed_at) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}`)
      .bind(...chunk.flatMap(row => [row.leaf, row.vector.buffer, row.papers, computedAt])));
  }
  await db.batch(statements);
  return centroids.length;
}

/**
 * Files the papers of each area lane. One a leaf of the area already holds
 * (its arXiv categories, a leaf's own lane) leaves the area lane. Then, in an
 * area with a rule, one whose vector the rule places under a leaf is filed
 * under it and leaves the area lane. Returns how many left area level.
 */
export async function fileAreaPapers(env: StoreEnv, rules: Readonly<Record<string, FilingRule>> = LEAF_FILING_RULES) {
  const db = database(env);
  // Each area lane row looks up its own paper's lanes (work_lanes_work), rather
  // than every row of the area's leaf lanes being read for it.
  const held = await db.batch(AREA_LANE_AREAS.map(area => db.prepare(`DELETE FROM work_lanes WHERE lane = ? AND EXISTS (
    SELECT 1 FROM work_lanes leaf WHERE leaf.work_id = work_lanes.work_id AND leaf.lane IN (SELECT value FROM json_each(?)))`)
    .bind(areaLane(area), JSON.stringify(leavesOf(area)))));
  let moved = held.reduce((sum, result) => sum + (result.meta?.changes || 0), 0);

  const calibrated = AREA_LANE_AREAS.filter(area => rules[area]);
  if (calibrated.length === 0) return moved;
  const { results: stored } = await db.prepare('SELECT leaf, embedding FROM leaf_centroids').all<{ leaf: string; embedding: unknown }>();
  const centroidOfLeaf = new Map(stored.map(row => [row.leaf, readVector(row.embedding)]));
  for (const area of calibrated) {
    const centroids = new Map(leavesOf(area).filter(leaf => centroidOfLeaf.has(leaf)).map(leaf => [leaf, centroidOfLeaf.get(leaf)!]));
    if (centroids.size < 2) continue;
    const { results } = await db.prepare(`SELECT l.work_id, l.published, v.embedding FROM work_lanes l
      JOIN work_vectors v ON v.work_id = l.work_id WHERE l.lane = ?`).bind(areaLane(area))
      .all<{ work_id: number; published: string; embedding: unknown }>();
    const filed = results.flatMap(row => {
      const closest = closestLeaf(readVector(row.embedding), centroids);
      return ruleFiles(closest, rules[area]) ? [{ lane: closest!.leaf, id: row.work_id, published: row.published }] : [];
    });
    for (let start = 0; start < filed.length; start += 400) {
      const chunk = JSON.stringify(filed.slice(start, start + 400));
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO work_lanes (lane, work_id, published)
          SELECT value ->> 'lane', value ->> 'id', value ->> 'published' FROM json_each(?)`).bind(chunk),
        db.prepare('DELETE FROM work_lanes WHERE lane = ? AND work_id IN (SELECT value ->> \'id\' FROM json_each(?))').bind(areaLane(area), chunk),
      ]);
    }
    moved += filed.length;
  }
  return moved;
}

/** Each leaf's centroid from these papers' vectors, for the leaves with at least MIN_CENTROID_PAPERS of them. */
export function leafCentroids(samples: Array<{ leaf: string; vector: Int8Array }>) {
  const byLeaf = new Map<string, Int8Array[]>();
  for (const { leaf, vector } of samples) {
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
    byLeaf.get(leaf)!.push(vector);
  }
  return new Map([...byLeaf].filter(([, vectors]) => vectors.length >= MIN_CENTROID_PAPERS).map(([leaf, vectors]) => [leaf, centroidOf(vectors)]));
}

/** The centroids of one area's leaves. */
export const areaCentroids = (area: string, centroids: ReadonlyMap<string, Int8Array>) => new Map(leavesOf(area)
  .filter(leaf => centroids.has(leaf)).map(leaf => [leaf, centroids.get(leaf)!]));

export interface FilingReport extends FilingRule { area: string; papers: number; filed: number; correct: number }

/**
 * For calibration: holds out every fifth arXiv paper of each leaf, takes the
 * centroids of the others, and files the held-out papers of each area under
 * each rule. A paper is filed correctly under its own primary category. A
 * held-out paper of a leaf without a centroid counts, and can only be filed
 * wrong, as a journal article of such a leaf would be. Areas with fewer than
 * two centroids are left out, as filing leaves them out.
 */
export function evaluateLeafFiling(samples: Array<{ leaf: string; vector: Int8Array }>, rules: FilingRule[]): FilingReport[] {
  const seen = new Map<string, number>();
  const heldOut: typeof samples = [];
  const training: typeof samples = [];
  for (const sample of samples) {
    const index = seen.get(sample.leaf) ?? 0;
    seen.set(sample.leaf, index + 1);
    (index % 5 === 4 ? heldOut : training).push(sample);
  }
  const centroids = leafCentroids(training);
  return AREA_LANE_AREAS.flatMap(area => {
    const own = areaCentroids(area, centroids);
    if (own.size < 2) return [];
    const leaves = new Set(leavesOf(area));
    const closest = heldOut.filter(sample => leaves.has(sample.leaf)).map(sample => ({ leaf: sample.leaf, closest: closestLeaf(sample.vector, own) }));
    return rules.map(rule => {
      const filed = closest.filter(paper => ruleFiles(paper.closest, rule));
      return { area, ...rule, papers: closest.length, filed: filed.length, correct: filed.filter(paper => paper.closest!.leaf === paper.leaf).length };
    });
  });
}
