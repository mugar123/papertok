import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { PaperBuilder } from './paper-builder.ts';
import { classifySimilarPapers } from './similar-feed-service.ts';

// Synthetic records. The recommendations are shaped like `mapRelatedPaper`'s:
// Semantic Scholar names the paper and its identifiers, never its field, and
// the record it builds calls every paper published.
const recommended = (fields: Partial<Paper>) => PaperBuilder.create({
  sources: { primary: 'semantic-scholar', enrichedBy: [] },
  publicationStatus: 'published',
  ...fields,
});

const arxivPaper = recommended({ id: 'arxiv:2601.00001', arxivId: '2601.00001', title: 'An arXiv paper' });
const biorxivPaper = recommended({ id: 's2-biorxiv', doi: '10.1101/2026.01.01.000001', title: 'A bioRxiv preprint' });
const unknownPaper = recommended({ id: 's2-unknown', doi: '10.5555/nobody-files-this', title: 'A paper nobody files' });

const arxivRecord = PaperBuilder.create({
  id: '2601.00001',
  arxivId: '2601.00001',
  sources: { primary: 'arxiv', enrichedBy: [] },
  title: 'An arXiv paper',
  categories: ['quant-ph'],
  primaryCategory: 'quant-ph',
  publicationStatus: 'preprint',
});

// Shaped like `formatOpenAlexWorkAsPaper` for a work OpenAlex types as a preprint.
const biorxivWork = PaperBuilder.create({
  id: 'openalex:W100',
  doi: '10.1101/2026.01.01.000001',
  sources: { primary: 'openalex', enrichedBy: [] },
  title: 'A bioRxiv preprint',
  publicationType: 'preprint',
  publicationStatus: 'preprint',
  primaryTopic: { id: 'T1', display_name: 'Gene regulation', field: { id: 'https://openalex.org/fields/13', display_name: 'Biochemistry, Genetics and Molecular Biology' } },
});

const quantumTopic = { id: 'T2', display_name: 'Quantum codes', field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' } };

test('shows each recommendation as the record its own page loads, once it has a field (PAP-50)', async () => {
  const { papers, unclassified } = await classifySimilarPapers([arxivPaper, biorxivPaper, unknownPaper], {
    fetchArxiv: async (ids) => (ids.includes('2601.00001') ? [arxivRecord] : []),
    enrich: async () => ({ '2601.00001': { primaryTopic: quantumTopic, concepts: [] } }),
    fetchByDois: async (dois) => (dois.includes('10.1101/2026.01.01.000001') ? [biorxivWork] : []),
  });

  assert.deepEqual(papers.map(paper => paper.title), ['An arXiv paper', 'A bioRxiv preprint'], 'in Semantic Scholar\'s order');
  assert.equal(unclassified, 1, 'the paper nobody could file is counted, not shown unclassified');
  assert.equal(papers[0].id, '2601.00001', 'an arXiv paper is the arXiv record the feed itself would show');
  assert.deepEqual(papers[0].categories, ['quant-ph'], 'with arXiv\'s own categories');
  assert.equal(papers[0].primaryTopic?.field?.display_name, 'Physics and Astronomy', 'and OpenAlex\'s topics on top');
  assert.equal(papers[1].id, 'openalex:W100', 'a DOI paper is the OpenAlex work');
  assert.ok(papers.every(paper => paper.publicationStatus === 'preprint'),
    'two preprints stay preprints: Semantic Scholar\'s "published" never reaches a card');
});

test('when arXiv does not answer, the paper\'s DOI work stands in; with neither, it is left out', async () => {
  const withDoi = recommended({ id: 'arxiv:2601.00002', arxivId: '2601.00002', doi: '10.1103/physrevb.1.000001', title: 'Published, also on arXiv' });
  const work = PaperBuilder.create({
    id: 'openalex:W200',
    doi: '10.1103/physrevb.1.000001',
    sources: { primary: 'openalex', enrichedBy: [] },
    title: 'Published, also on arXiv',
    publicationStatus: 'published',
    primaryTopic: quantumTopic,
  });
  const { papers, unclassified } = await classifySimilarPapers([withDoi, arxivPaper], {
    fetchArxiv: async () => { throw new Error('arXiv 429'); },
    enrich: async () => ({}),
    fetchByDois: async () => [work],
  });

  assert.deepEqual(papers.map(paper => paper.id), ['openalex:W200']);
  assert.equal(unclassified, 1);
});

test('waits a bounded time: providers that never answer leave nothing to show, not a skeleton for ever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = () => new Promise<never>(() => {});
  let outcome: Awaited<ReturnType<typeof classifySimilarPapers>> | null = null;
  void classifySimilarPapers([arxivPaper, biorxivPaper], { fetchArxiv: never, enrich: never, fetchByDois: never })
    .then(value => { outcome = value; });

  const drain = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  await drain();
  t.mock.timers.tick(7_999);
  await drain();
  assert.equal(outcome, null, 'still waiting for the classification');

  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(outcome, { papers: [], unclassified: 2 });
});
