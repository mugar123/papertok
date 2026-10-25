// Calibration of the leaf filing (worker/leaf-filing.ts) on a copy of the
// paper store: how many held-out arXiv papers each rule files, and how many of
// those under their own leaf; and how many of the area lanes' journal articles
// each rule would file. Node only, like sqlite-d1.ts: it runs the store's SQL
// over node:sqlite, outside the Worker.
//
//   node worker/test-support/evaluate-leaf-filing.ts <store.sqlite | store.sql> [--similarity 0.5,0.6] [--margin 0.05,0.1]
//
// The copy is the SQLite file of a local D1 (under .wrangler/state), or an
// export of the store: `npx wrangler d1 export papertok-paper-store --remote
// --output store.sql`, run by whoever runs D1. It prints one JSON object,
// `arxiv` and `areaLanes`, with a row per rule for each area that has two
// leaf centroids or more. Centroids here are taken over every arXiv paper with
// a vector, where the harvest takes each leaf's newest 500.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAllLeafCategories } from '../../src/data/category-taxonomy.ts';
import { areaCentroids, closestLeaf, evaluateLeafFiling, leafCentroids, ruleFiles } from '../leaf-filing.ts';
import { AREA_LANE_AREAS, areaLane, readVector } from '../paper-store.ts';

export function evaluateStoreCopy(path: string, rules: Array<{ similarity: number; margin: number }>) {
  const db = path.endsWith('.sql') ? new DatabaseSync(':memory:') : new DatabaseSync(path, { readOnly: true });
  try {
    if (path.endsWith('.sql')) db.exec(readFileSync(path, 'utf8'));
    const leaves = getAllLeafCategories().filter(leaf => AREA_LANE_AREAS.includes(leaf.area)).map(leaf => leaf.id);
    const samples = (db.prepare(`SELECT w.paper ->> 'primaryCategory' AS leaf, v.embedding FROM works w
      JOIN work_vectors v ON v.work_id = w.id
      WHERE w.paper ->> 'arxivId' IS NOT NULL AND w.paper ->> 'primaryCategory' IN (SELECT value FROM json_each(?))
      ORDER BY w.id`).all(JSON.stringify(leaves)) as Array<{ leaf: string; embedding: Uint8Array }>)
      .map(row => ({ leaf: row.leaf, vector: readVector(row.embedding) }));

    const centroids = leafCentroids(samples);
    const areaLanes = AREA_LANE_AREAS.flatMap(area => {
      const own = areaCentroids(area, centroids);
      if (own.size < 2) return [];
      const closest = (db.prepare('SELECT v.embedding FROM work_lanes l JOIN work_vectors v ON v.work_id = l.work_id WHERE l.lane = ?')
        .all(areaLane(area)) as Array<{ embedding: Uint8Array }>).map(row => closestLeaf(readVector(row.embedding), own));
      return rules.map(rule => ({ area, ...rule, papers: closest.length, filed: closest.filter(paper => ruleFiles(paper, rule)).length }));
    });
    return { arxiv: evaluateLeafFiling(samples, rules), areaLanes };
  } finally {
    db.close();
  }
}

const usage = 'Usage: node worker/test-support/evaluate-leaf-filing.ts <store.sqlite | store.sql> [--similarity 0.4,0.5] [--margin 0.05,0.1]';

function fail(message: string): never {
  process.stderr.write(`${message}\n${usage}\n`);
  process.exit(1);
}

function numbers(text: string | undefined, fallback: number[]) {
  if (text === undefined) return fallback;
  const parsed = text.split(',').map(Number);
  if (parsed.some(value => !Number.isFinite(value))) fail(`Not a list of numbers: ${text}`);
  return parsed;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { similarity: { type: 'string' }, margin: { type: 'string' } },
  });
  if (positionals.length !== 1) fail('Name one copy of the paper store.');
  const rules = numbers(values.similarity, [0.3, 0.4, 0.5, 0.6, 0.7])
    .flatMap(similarity => numbers(values.margin, [0.02, 0.05, 0.1, 0.15, 0.2]).map(margin => ({ similarity, margin })));
  process.stdout.write(`${JSON.stringify(evaluateStoreCopy(positionals[0], rules), null, 1)}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
