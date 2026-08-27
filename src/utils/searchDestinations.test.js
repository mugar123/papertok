import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPaperDestination } from './searchDestinations.js';
import { decodePaperKey } from './publicNavigation.js';

test('a paper goes to the public paper page, never to the entity explorer', () => {
  // The regression: `/explorer/paper/<id>` is not a route. `/explorer/:type/:id`
  // mounts the entity explorer, which has no notion of a paper, so the id was
  // asked of the authors endpoint and came back 404 — "Entity not found".
  const { path } = searchPaperDestination({ doi: '10.1038/nature12373' });
  assert.match(path, /^\/public\/paper\//);
  assert.doesNotMatch(path, /explorer/);
});

test('the path carries a key the public page can decode back', () => {
  const { path } = searchPaperDestination({ doi: 'https://doi.org/10.1038/nature12373' });
  const key = decodeURIComponent(path.split('/').pop());
  assert.equal(decodePaperKey(key), 'doi:10.1038/nature12373');
});

test('an arXiv preprint with no DOI still has an address', () => {
  const { path } = searchPaperDestination({ arxivId: '2401.00001' });
  const key = decodeURIComponent(path.split('/').pop());
  assert.equal(decodePaperKey(key), 'arxiv:2401.00001');
});

test('the paper rides along so the page paints before the network answers', () => {
  // `PublicPaperPage` renders `location.state.paper` immediately and treats its
  // own fetch as an upgrade. The palette already holds the whole paper.
  const paper = { doi: '10.1038/nature12373', title: 'A paper' };
  const { state } = searchPaperDestination(paper);
  assert.equal(state.paper, paper);
});

test('a paper with no DOI and no arXiv id falls back to the search page, not to a dead link', () => {
  const { path, state } = searchPaperDestination({ title: 'Untitled work' }, 'character sums');
  assert.equal(path, '/search?q=character%20sums');
  assert.equal(state, null);
});

test('the fallback uses the title when there is no query to carry', () => {
  const { path } = searchPaperDestination({ title: 'Long large character sums' });
  assert.equal(path, '/search?q=Long%20large%20character%20sums');
});

test('a paper with nothing at all still lands on a real route', () => {
  for (const input of [null, undefined, {}, { title: '   ' }]) {
    assert.equal(searchPaperDestination(input).path, '/search');
  }
});
