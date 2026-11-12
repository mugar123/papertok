import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { paperLegacyAdapter } from '../models/paper.ts';
import { areaLabelForPaper } from '../utils/area-accent.ts';
import { fieldRequestFor, readPaperFields } from './list-paper-fields.ts';

// The lists ask a provider the field of saved papers stored with none (`readPaperFields`).

const arxivPaper = (id: string, categories: string[]) => ({ id, arxivId: id, title: 'From arXiv', primaryCategory: categories[0], categories }) as Paper;
const topic = { id: 'https://openalex.org/T10020', display_name: 'Quantum Information', field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' } };
// The row's paper after the answer, as the list reads a stored copy.
const areaWith = (paperId: string, stored: Partial<Paper>, field: Partial<Paper> | undefined) => areaLabelForPaper(paperLegacyAdapter({ id: paperId, title: 'Stored', ...stored, ...field }));

test('each paper is asked of the provider that can name its field, under the id the list holds', async () => {
  const arxivAsked: string[][] = [];
  const openAlexAsked: string[][] = [];
  const papers: Record<string, Partial<Paper>> = {
    '2505.06123': { primaryCategory: undefined },
    // Saved from an INSPIRE card: another provider's id, with the arXiv id beside it.
    'inspire:2920001': { arxivId: '2511.00001v2' },
    'ads:2025a': { doi: 'https://doi.org/10.1103/PhysRevB.42.892' },
    'ads:2025b': { doi: '10.5555/unknown' },
    'pmid:1': {},
  };
  const { fields, failed } = await readPaperFields(papers, {
    fetchArxivPapers: async (ids) => {
      arxivAsked.push(ids);
      return [arxivPaper('2505.06123', ['quant-ph', 'cond-mat.mes-hall']), arxivPaper('2511.00001', ['hep-th'])];
    },
    fetchOpenAlexWorks: async (ids) => {
      openAlexAsked.push(ids);
      return { 'doi:10.1103/physrevb.42.892': { primaryTopic: topic } };
    },
  });

  assert.deepEqual(arxivAsked, [['2505.06123', '2511.00001']], 'one arXiv request, without versions');
  assert.deepEqual(openAlexAsked, [['doi:10.1103/physrevb.42.892', 'doi:10.5555/unknown']], 'only the papers with no arXiv id');
  assert.deepEqual(failed, []);
  assert.deepEqual(Object.keys(fields).sort(), ['2505.06123', 'ads:2025a', 'inspire:2920001'], 'no field for a paper the provider does not know, or one with no id to ask by');
  assert.deepEqual(fields['2505.06123'].categories, ['quant-ph', 'cond-mat.mes-hall']);
  assert.equal(areaWith('2505.06123', { primaryCategory: 'physics.optics' }, undefined), null, 'the stored category alone is no field');
  assert.equal(areaWith('2505.06123', { primaryCategory: 'physics.optics' }, fields['2505.06123']), 'Physics');
  assert.equal(areaWith('inspire:2920001', { primaryCategory: 'physics' }, fields['inspire:2920001']), 'Physics');
  assert.deepEqual(fields['ads:2025a'], { primaryTopic: topic });
});

test('an arXiv request that fails leaves its papers askable and the others filled', async () => {
  const { fields, failed } = await readPaperFields({
    '2505.06123': {},
    'openalex:W4410000002': { doi: '10.1103/physrevb.42.892' },
  }, {
    fetchArxivPapers: async () => { throw new Error('arXiv is down'); },
    fetchOpenAlexWorks: async () => ({ 'openalex:W4410000002': { primaryTopic: topic } }),
  });
  assert.deepEqual(failed, ['2505.06123']);
  assert.deepEqual(Object.keys(fields), ['openalex:W4410000002']);
});

test('each id is asked the way its provider reads it', () => {
  const request = (paperId: string, paper: Partial<Paper> = {}) => fieldRequestFor(paperId, paper);
  assert.deepEqual(request('arxiv:2505.06123v3'), { provider: 'arxiv', id: '2505.06123' });
  assert.deepEqual(request('math.GT/0309136'), { provider: 'arxiv', id: 'math.GT/0309136' }, 'an old-style id keeps its case');
  assert.deepEqual(request('openalex:W4410000002'), { provider: 'openalex', id: 'openalex:W4410000002' }, 'a work id needs no DOI');
  assert.deepEqual(request('ads:2025x', { doi: 'https://doi.org/10.1103/PhysRevB.42.892' }), { provider: 'openalex', id: 'doi:10.1103/physrevb.42.892' });
  // arXiv's own DOI names the arXiv paper again, and OpenAlex reads `,` as a separator.
  assert.equal(request('ads:2025y', { doi: '10.48550/arXiv.2505.06123' }), null);
  assert.equal(request('ads:2025z', { doi: '10.1000/a,10.1000/b' }), null);
  assert.deepEqual(request('doi:10.1103/PhysRevB.42.892'), { provider: 'openalex', id: 'doi:10.1103/physrevb.42.892' }, 'a paper stored under its DOI');
  assert.equal(request('pmid:1'), null);
});

test('arXiv is asked fifty papers at a time', async () => {
  const asked: number[] = [];
  const papers = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`2505.${String(10000 + index)}`, {}]));
  await readPaperFields(papers, { fetchArxivPapers: async (ids) => { asked.push(ids.length); return []; } });
  assert.deepEqual(asked, [50, 50, 20]);
});
