import assert from 'node:assert/strict';
import test from 'node:test';

import { carryArxivVectors } from './paper-harvest.ts';
import { ingestPapers } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { testD1 } from './test-support/sqliteD1.ts';

const NOW = Date.parse('2026-10-22T03:00:00Z');
const record = (arxivId: string, title: string, abstract: string) => arxivRecordPaper({
  arxivId,
  title,
  abstract,
  authors: ['Ana Pérez'],
  categories: ['cs.CL'],
  doi: null,
  journalRef: null,
  comments: null,
  published: '2026-10-10T12:00:00.000Z',
  updated: '2026-10-10T12:00:00.000Z',
});

// The run carries the vectors of the arXiv-only store (migration 0001) every
// night. A new version that changes a paper's text drops its vector, and the
// next carry, in the same run, put the old version's back.
test("the old store's vector moves to a row with the same text, never to a revised one", async () => {
  const { binding, db } = testD1();
  const env = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
  const firstVersions = [
    record('2610.11111', 'Sparse attention for long documents', 'We make attention sparse.'),
    record('2610.22222', 'Dense retrieval for scientific question answering', 'We retrieve passages densely.'),
  ];
  for (const paper of firstVersions) {
    db.prepare(`INSERT INTO papers VALUES (?, ?, ?, '[]', '["cs.CL"]', NULL, NULL, NULL, '2026-10-10', '2026-10-10')`).run(paper.id, paper.title, paper.abstract);
    db.prepare(`INSERT INTO paper_vectors VALUES (?, x'0707')`).run(paper.id);
  }
  await ingestPapers(env, firstVersions.map(paper => ({ paper, lanes: [] })), { now: NOW });
  await carryArxivVectors(binding)();
  const carried = () => db.prepare(`SELECT k.key FROM work_vectors v JOIN work_keys k ON k.work_id = v.work_id WHERE k.key LIKE 'arxiv:%' ORDER BY k.key`).all().map(row => row.key);
  assert.deepEqual(carried(), ['arxiv:2610.11111', 'arxiv:2610.22222']);

  const revision = record('2610.22222', 'Dense retrieval for scientific question answering', 'We retrieve passages densely, and rerank them.');
  await ingestPapers(env, [{ paper: revision, lanes: [] }], { now: NOW });
  await carryArxivVectors(binding)();
  assert.deepEqual(carried(), ['arxiv:2610.11111'], 'the revised paper waits for the embedding pass');
});
