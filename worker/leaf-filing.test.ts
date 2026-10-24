import type { Paper } from '../src/models/Paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/openAlexTypes.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateLeafFiling, fileAreaPapers, storeLeafCentroids } from './leaf-filing.ts';
import { ingestPapers, parseFeedRequest, quantize, readFeedPage, readVector } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { mapOpenAlexWork } from '../src/utils/openAlexWork.ts';
import { testD1 } from './test-support/sqliteD1.ts';

const NOW = Date.parse('2026-10-23T03:00:00Z');

// Synthetic embeddings: each leaf's papers point along one axis of the stored
// 256 dimensions, with a little seeded noise in every dimension.
function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
}
function vector(axes: Record<number, number>, seed: number) {
  const next = noise(seed);
  return quantize(Array.from({ length: 256 }, (_, index) => (axes[index] || 0) + 0.04 * next()));
}
const cosine = (a: Int8Array, b: Int8Array) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((value, index) => { dot += value * b[index]; na += value * value; nb += b[index] * b[index]; });
  return dot / Math.sqrt(na * nb);
};

function corpus() {
  const { binding, db } = testD1();
  const env = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
  const workOf = (key: string) => (db.prepare('SELECT work_id FROM work_keys WHERE key = ?').get(key) as { work_id: number }).work_id;
  const setVector = (key: string, embedding: Int8Array) => db.prepare('INSERT OR REPLACE INTO work_vectors (work_id, embedding) VALUES (?, ?)')
    .run(workOf(key), Buffer.from(embedding.buffer));
  const lane = (name: string) => (db.prepare('SELECT work_id FROM work_lanes WHERE lane = ? ORDER BY work_id').all(name) as Array<{ work_id: number }>).map(row => row.work_id);
  return { env, db, workOf, setVector, lane };
}

// `count` arXiv papers whose primary category is `leaf`, each with a vector along `axis`.
async function arxivPapers(store: ReturnType<typeof corpus>, leaf: string, count: number, axis: number, from: number) {
  const papers = Array.from({ length: count }, (_, index) => arxivRecordPaper({
    arxivId: `2610.${String(from + index).padStart(5, '0')}`,
    title: `A ${leaf} preprint, number ${from + index}, about its own subject`,
    abstract: `The ${leaf} abstract of preprint ${from + index}.`,
    authors: ['Ana Pérez'],
    categories: [leaf],
    doi: null,
    journalRef: null,
    comments: null,
    published: new Date(NOW - (index + 1) * 3_600_000).toISOString(),
    updated: new Date(NOW - (index + 1) * 3_600_000).toISOString(),
  }));
  await ingestPapers(store.env, papers.map(paper => ({ paper, lanes: [] })), { now: NOW });
  papers.forEach((paper, index) => store.setVector(`arxiv:${paper.arxivId}`, vector({ [axis]: 1 }, from + index)));
}

// An OpenAlex journal article, as an area's journal lane lists it.
function journalArticle(id: string, extra: Partial<OpenAlexWork> = {}) {
  return mapOpenAlexWork({
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/10.1103/${id.toLowerCase()}`,
    title: `Journal article ${id} reporting a physics result`,
    type: 'article',
    publication_date: '2026-10-23',
    authorships: [],
    abstract_inverted_index: { A: [0], physics: [1], result: [2] },
    primary_location: { is_oa: false, landing_page_url: `https://doi.org/10.1103/${id.toLowerCase()}`, source: { id: 'https://openalex.org/S1', display_name: 'A Physics Journal', type: 'journal' } },
    open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
    primary_topic: {
      id: 'https://openalex.org/T1',
      display_name: 'A physics topic',
      subfield: { id: 'https://openalex.org/subfields/3106', display_name: 'Nuclear and High Energy Physics' },
      field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' },
    },
    ...extra,
  } as OpenAlexWork)!;
}

const PHYSICS_RULE = { physics: { similarity: 0.8, margin: 0.2 } };

test("a leaf's centroid is the mean of its own arXiv papers' vectors; papers other sources filed under it, and a leaf with too few, give none", async () => {
  const store = corpus();
  await arxivPapers(store, 'hep-th', 60, 0, 0);
  await arxivPapers(store, 'quant-ph', 60, 1, 100);
  await arxivPapers(store, 'astro-ph.GA', 3, 2, 200);
  // A record another source filed under quant-ph, naming the category itself
  // as PubMed and bioRxiv records name theirs, but no arXiv paper.
  const stray = Array.from({ length: 80 }, (_, index) => ({ ...journalArticle(`W9${index}`), primaryCategory: 'quant-ph' }) as Partial<Paper>);
  await ingestPapers(store.env, stray.map(paper => ({ paper, lanes: ['quant-ph'] })), { now: NOW });
  stray.forEach((paper, index) => store.setVector(`id:${paper.id!.toLowerCase()}`, vector({ 5: 1 }, 300 + index)));

  // Only filing reads them, and only in an area with a rule: the shipped rules have none.
  assert.equal(await storeLeafCentroids(store.env, NOW), 0);
  assert.deepEqual(store.db.prepare('SELECT leaf FROM leaf_centroids').all(), []);
  assert.equal(await storeLeafCentroids(store.env, NOW, PHYSICS_RULE), 2);
  const centroids = new Map((store.db.prepare('SELECT leaf, embedding, papers FROM leaf_centroids').all() as Array<{ leaf: string; embedding: Uint8Array; papers: number }>)
    .map(row => [row.leaf, { vector: readVector(row.embedding), papers: row.papers }]));
  assert.deepEqual([...centroids.keys()].sort(), ['hep-th', 'quant-ph']);
  assert.equal(centroids.get('quant-ph')!.papers, 60);
  assert.ok(cosine(centroids.get('quant-ph')!.vector, vector({ 1: 1 }, 1)) > 0.95);
  assert.ok(cosine(centroids.get('quant-ph')!.vector, vector({ 5: 1 }, 1)) < 0.2, 'the other records do not pull it');
  assert.ok(cosine(centroids.get('hep-th')!.vector, vector({ 0: 1 }, 1)) > 0.95);
});

test('an area lane holds only what no leaf of the area holds: shipped rules file nothing under a leaf, a calibrated rule files only clear matches', async () => {
  const store = corpus();
  await arxivPapers(store, 'hep-th', 60, 0, 0);
  await arxivPapers(store, 'quant-ph', 60, 1, 100);
  const clear = journalArticle('W1');
  const between = journalArticle('W2');
  const elsewhere = journalArticle('W3');
  // The journal version of one of the quant-ph preprints: one row, held by quant-ph.
  const published = journalArticle('W4', { locations: [{ landing_page_url: 'https://arxiv.org/abs/2610.00100', source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)' } }] });
  await ingestPapers(store.env, [clear, between, elsewhere, published].map(paper => ({ paper, lanes: ['area:physics'] })), { now: NOW });
  store.setVector('id:openalex:w1', vector({ 0: 1 }, 1_001));
  store.setVector('id:openalex:w2', vector({ 0: 1, 1: 1 }, 1_002));
  store.setVector('id:openalex:w3', vector({ 7: 1 }, 1_003));
  assert.equal(store.workOf('id:openalex:w4'), store.workOf('arxiv:2610.00100'), 'one row for the article and its preprint');
  await storeLeafCentroids(store.env, NOW, PHYSICS_RULE);
  const [w1, w2, w3, w4] = ['w1', 'w2', 'w3', 'w4'].map(id => store.workOf(`id:openalex:${id}`));

  await fileAreaPapers(store.env);
  assert.ok(store.lane('quant-ph').includes(w4));
  assert.deepEqual(store.lane('area:physics'), [w1, w2, w3].sort((a, b) => a - b), 'the preprint\'s leaf holds the published version');
  assert.ok(!store.lane('hep-th').includes(w1), 'uncalibrated: nothing is filed under a leaf');

  await fileAreaPapers(store.env, PHYSICS_RULE);
  assert.deepEqual(store.lane('area:physics'), [w2, w3].sort((a, b) => a - b), 'between two leaves, or close to none, it stays at area level');
  assert.ok(store.lane('hep-th').includes(w1));
  assert.ok(!store.lane('quant-ph').includes(w2));
  const page = await readFeedPage(store.env, parseFeedRequest({ categories: ['hep-th'], pageSize: 30 }), { now: NOW });
  assert.deepEqual(page.find(paper => paper.id === 'openalex:W1')?._fetchedFor, ['hep-th']);
  const quantumPage = await readFeedPage(store.env, parseFeedRequest({ categories: ['quant-ph'], pageSize: 30 }), { now: NOW });
  assert.equal(quantumPage.some(paper => paper.id === 'openalex:W1'), false, 'a filed article leaves the readers of other leaves');
});

test('the evaluation files held-out arXiv papers against centroids of the others, and reports precision and coverage per area and rule', () => {
  const papers = (leaf: string, axes: (index: number) => Record<number, number>, seed: number) => Array.from({ length: 70 }, (_, index) => ({ leaf, vector: vector(axes(index), seed + index) }));
  // Two leaves whose papers overlap: each paper leans a random amount along
  // axis 3, its leaf's way on average.
  const lean = noise(7);
  const samples = [
    ...papers('hep-th', () => ({ 0: 1 }), 0),
    ...papers('quant-ph', () => ({ 1: 1 }), 100),
    ...papers('cond-mat.str-el', () => ({ 2: 1, 3: 0.1 + 0.8 * lean() }), 200),
    ...papers('cond-mat.supr-con', () => ({ 2: 1, 3: -0.1 + 0.8 * lean() }), 300),
    // An area with one leaf: nothing to tell it apart from.
    ...papers('math.AG', () => ({ 4: 1 }), 400),
  ];
  const report = evaluateLeafFiling(samples, [{ similarity: 0.5, margin: 0.02 }, { similarity: 0.5, margin: 0.3 }]);
  assert.deepEqual(report.map(row => row.area), ['physics', 'physics']);
  const [loose, strict] = report;
  // Every fifth paper of each leaf is held out: 14 of each of four leaves.
  assert.equal(loose.papers, 56);
  assert.equal(strict.papers, 56);
  assert.equal(strict.filed, 28, 'the two distinct leaves, and none of the alike ones');
  assert.equal(strict.correct, strict.filed);
  assert.ok(loose.filed > strict.filed, 'a narrower margin files more');
  assert.ok(loose.correct < loose.filed, 'and mixes up the alike leaves');
});
