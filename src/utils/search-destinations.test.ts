import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPaperDestination } from './search-destinations.ts';
import { decodePaperKey } from './public-navigation.ts';

test('a paper goes to the public paper page, never to the entity explorer', () => {
  // The regression: `/explorer/paper/<id>` is not a route. `/explorer/:type/:id`
  // mounts the entity explorer, which has no notion of a paper, so the id was
  // asked of the authors endpoint and came back 404 — "Entity not found".
  const { path } = searchPaperDestination({ doi: '10.1038/nature12373' });
  assert.match(path, /^\/paper\//);
  assert.doesNotMatch(path, /explorer/);
});

test('the path carries a key the public page can decode back', () => {
  const { path } = searchPaperDestination({ doi: 'https://doi.org/10.1038/nature12373' });
  const key = decodeURIComponent(path.split('/').pop()!);
  assert.equal(decodePaperKey(key), 'doi:10.1038/nature12373');
});

test('an arXiv preprint with no DOI still has an address', () => {
  const { path } = searchPaperDestination({ arxivId: '2401.00001' });
  const key = decodeURIComponent(path.split('/').pop()!);
  assert.equal(decodePaperKey(key), 'arxiv:2401.00001');
});

test('the paper rides along so the page paints before the network answers', () => {
  // `PublicPaperPage` renders `location.state.paper` immediately and treats its
  // own fetch as an upgrade. The palette already holds the whole paper.
  const paper = { doi: '10.1038/nature12373', title: 'A paper' };
  const { state } = searchPaperDestination(paper);
  assert.equal(state!.paper, paper);
});

test('a paper with no DOI and no arXiv id falls back to the search page, not to a dead link', () => {
  const { path } = searchPaperDestination({ title: 'Untitled work' }, 'character sums');
  assert.equal(path, '/search?q=character%20sums');
});

test('the paper rides along to the search page too, so it opens there instead of being listed again', () => {
  // Keyed by an id nobody can open, with no DOI and no arXiv id beside it.
  const paper = { id: 's2:649def34f8be52c8b66281af98ae884c09aef38b', title: 'Long large character sums' };
  const { path, state } = searchPaperDestination(paper, 'character sums');
  assert.equal(path, '/search?q=character%20sums');
  assert.equal(state!.paper, paper);
});

test('a paper only OpenReview holds has an address of its own', () => {
  const paper = { id: 'openreview:5pShDP8LSm', openReviewId: '5pShDP8LSm', title: 'Position: AI Development Should Prioritize Cognitive Security' };
  const { path, state } = searchPaperDestination(paper, 'cognitive security');
  assert.equal(decodePaperKey(decodeURIComponent(path.split('/').pop()!)), 'openreview:5pShDP8LSm');
  assert.equal(state!.paper, paper);
});

test('the fallback uses the title when there is no query to carry', () => {
  const { path } = searchPaperDestination({ title: 'Long large character sums' });
  assert.equal(path, '/search?q=Long%20large%20character%20sums');
});

test('a paper with nothing at all still lands on a real route', () => {
  for (const input of [null, undefined, {}, { title: '   ' }]) {
    assert.deepEqual(searchPaperDestination(input!), { path: '/search', state: null });
  }
});
