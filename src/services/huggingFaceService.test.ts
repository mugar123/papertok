import test from 'node:test';
import assert from 'node:assert/strict';
import { mapHuggingFacePaper, mapHuggingFaceResources } from './huggingFaceService.ts';

test('maps a Hugging Face paper without claiming peer review or citations', () => {
  const paper = mapHuggingFacePaper({
    paper: {
      id: '2607.12345',
      title: 'A useful language model',
      summary: 'Model summary.',
      authors: [{ name: 'Ada Researcher' }],
      publishedAt: '2026-07-12T00:00:00Z',
      upvotes: 42,
      ai_keywords: ['language models'],
      githubRepo: 'https://github.com/example/model',
    },
  }, ['cs.CL']);

  assert.equal(paper.id, 'arxiv:2607.12345');
  assert.equal(paper.sources.primary, 'huggingface');
  assert.equal(paper.primaryCategory, 'cs.CL');
  assert.equal(paper.peerReviewed, false);
  assert.equal(paper.citationCountKnown, false);
  assert.equal(paper.huggingFaceUpvotes, 42);
  assert.equal(paper.researchResources[0].kind, 'software');
});

test('maps linked Hugging Face models and datasets as research resources', () => {
  const resources = mapHuggingFaceResources({
    linkedModels: [{ id: 'paper/model', downloads: 12, likes: 3 }],
    linkedDatasets: [{ id: 'paper/data', downloads: 8, likes: 2 }],
    projectPage: 'https://example.org/project',
  });

  assert.deepEqual(resources.map(item => item.kind), ['model', 'dataset', 'material']);
  assert.equal(resources[0].downloads, 12);
  assert.match(resources[1].url, /huggingface\.co\/datasets/);
});
