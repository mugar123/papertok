import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterRelevantQueryTopicPapers,
  scoreQueryTopicPaper,
} from './queryTopicSearch.js';

const TOPIC = {
  query: 'spatial transcriptomics',
  categoryIds: [],
};

test('ranks exact semantic and title evidence above looser matches', () => {
  const papers = [
    {
      id: 'scattered-abstract',
      title: 'Cell atlases across tissues',
      abstract: 'Spatial variation is measured before a later transcriptomics analysis.',
    },
    {
      id: 'loose-title',
      title: 'Spatial maps for single-cell transcriptomics',
    },
    {
      id: 'exact-title-phrase',
      title: 'Spatial transcriptomics maps the developing heart',
    },
    {
      id: 'exact-concept',
      title: 'A tissue atlas',
      concepts: [{ display_name: 'Spatial transcriptomics' }],
    },
    {
      id: 'unrelated',
      title: 'Spatial statistics for urban mobility',
      abstract: 'A geographic analysis without molecular measurements.',
    },
  ];

  assert.deepEqual(
    filterRelevantQueryTopicPapers(papers, TOPIC).map(paper => paper.id),
    ['exact-concept', 'exact-title-phrase', 'loose-title'],
  );
  assert.equal(scoreQueryTopicPaper(papers[0], TOPIC), 58);
});

test('normalizes punctuation and accents for exact scientific phrases', () => {
  const topic = { query: 'edicion genetica CRISPR-Cas9', categoryIds: [] };
  const paper = { title: 'Edición genética con CRISPR Cas9 en células humanas' };

  assert.equal(scoreQueryTopicPaper(paper, topic), 80);
  assert.deepEqual(filterRelevantQueryTopicPapers([paper], topic), [paper]);
});

test('accepts exact source categories without trusting an injected primary category', () => {
  const topic = { query: 'nlin.CD', categoryIds: ['nlin.CD'] };
  const exact = { id: 'exact', categories: ['nlin.CD'], title: 'Chaotic dynamics' };
  const primaryOnly = { id: 'primary', categories: [], primaryCategory: 'nlin.CD', title: 'Chaotic dynamics' };
  const injected = {
    id: 'injected',
    categories: ['physics.chem-ph'],
    primaryCategory: 'nlin.CD',
    title: 'Water dehydrogenation by scandium',
  };

  assert.equal(scoreQueryTopicPaper(exact, topic), 140);
  assert.equal(scoreQueryTopicPaper(primaryOnly, topic), 140);
  assert.equal(scoreQueryTopicPaper(injected, topic), 0);
  assert.deepEqual(
    filterRelevantQueryTopicPapers([injected, primaryOnly, exact], topic).map(paper => paper.id),
    ['primary', 'exact'],
  );
});

test('rejects partial title and dispersed abstract token matches by default', () => {
  const topic = { query: 'quantum gravity simulation', categoryIds: [] };
  const partialTitle = { title: 'Quantum gravity in curved spacetime' };
  const dispersedAbstract = {
    title: 'Models of curved spacetime',
    abstract: 'Quantum effects are studied. Gravity is discussed. A simulation follows.',
  };

  assert.ok(scoreQueryTopicPaper(partialTitle, topic) < 70);
  assert.ok(scoreQueryTopicPaper(dispersedAbstract, topic) < 70);
  assert.deepEqual(filterRelevantQueryTopicPapers([partialTitle, dispersedAbstract], topic), []);
});
