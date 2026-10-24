import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { quantize } from '../paper-store.ts';
import { evaluateStoreCopy } from './evaluate-leaf-filing.ts';

// A synthetic store export: arXiv papers of two physics leaves, and three
// journal articles in the physics area lane, with vectors along fixed axes.
function storeExport(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pap107-evaluation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.sqlite');
  const db = new DatabaseSync(file);
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(entry => entry.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  let id = 0;
  const add = (paper: Record<string, unknown>, lane: string, axes: Record<number, number>) => {
    id += 1;
    const values = Array.from({ length: 256 }, (_, index) => (axes[index] || 0) + 0.01 * Math.sin(id * 31 + index));
    db.prepare("INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, '2026-10-20', '2027-01-18')").run(id, JSON.stringify(paper));
    db.prepare("INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, '2026-10-20')").run(lane, id);
    db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)').run(id, Buffer.from(quantize(values).buffer));
  };
  for (let index = 0; index < 70; index += 1) {
    add({ id: `2610.${10_000 + index}`, arxivId: `2610.${10_000 + index}`, primaryCategory: 'hep-th' }, 'hep-th', { 0: 1 });
    add({ id: `2610.${20_000 + index}`, arxivId: `2610.${20_000 + index}`, primaryCategory: 'quant-ph' }, 'quant-ph', { 1: 1 });
  }
  add({ id: 'openalex:W1' }, 'area:physics', { 0: 1 });
  add({ id: 'openalex:W2' }, 'area:physics', { 0: 1, 1: 1 });
  add({ id: 'openalex:W3' }, 'area:physics', { 7: 1 });
  db.close();
  return file;
}

test('the evaluation reads a store export: held-out arXiv papers per area and rule, and what each rule would file of the area lanes', t => {
  const { arxiv, areaLanes } = evaluateStoreCopy(storeExport(t), [{ similarity: 0.5, margin: 0.3 }]);
  assert.deepEqual(arxiv, [{ area: 'physics', similarity: 0.5, margin: 0.3, papers: 28, filed: 28, correct: 28 }]);
  assert.deepEqual(areaLanes, [{ area: 'physics', similarity: 0.5, margin: 0.3, papers: 3, filed: 1 }]);
});
