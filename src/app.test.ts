import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '../tests/dom/render-app.ts';
import { waitFor } from '@testing-library/react';

// ENG-44: a paper's page moved from /public/paper/:key to /paper/:key. Visits
// that never ask the server for the old address are redirected by the route.
test('the legacy paper address redirects to the paper, keeping its query and fragment, in the same history entry', async () => {
  const app = await renderApp('/public/paper/YXJ4aXY6MjQwMS4wMDAwMQ?from=share#abstract');
  try {
    await waitFor(() => assert.equal(window.location.pathname, '/paper/YXJ4aXY6MjQwMS4wMDAwMQ'));
    assert.equal(window.location.search, '?from=share');
    assert.equal(window.location.hash, '#abstract');
    assert.equal(window.history.length, 1);
  } finally {
    await app.stop();
  }
});

// ENG-218: /paper/<type>:<id> written by hand moves to the paper's canonical
// address, in the same history entry, before the page renders.
const READABLE_PAPERS = [
  { name: 'a new-style arXiv id', address: '/paper/arxiv:2401.00001', identity: 'arxiv:2401.00001' },
  { name: 'an arXiv id with its colon encoded', address: '/paper/arxiv%3A1706.03762', identity: 'arxiv:1706.03762' },
  { name: 'an arXiv id with a version', address: '/paper/arxiv:1706.03762v7', identity: 'arxiv:1706.03762v7' },
  { name: 'an old-style arXiv id written with %2F', address: '/paper/arxiv:hep-th%2F9901001', identity: 'arxiv:hep-th/9901001' },
  { name: 'a DOI written with %2F', address: '/paper/doi:10.1000%2FABC', identity: 'doi:10.1000/abc' },
  { name: 'an OpenAlex id', address: '/paper/openalex:w2741809807', identity: 'openalex:W2741809807' },
  { name: 'a type in capitals', address: '/paper/ARXIV:2401.00001', identity: 'arxiv:2401.00001' },
];

for (const { name, address, identity } of READABLE_PAPERS) {
  test(`a readable address with ${name} ends at the paper's canonical path`, async () => {
    const app = await renderApp(address);
    try {
      await waitFor(() => assert.equal(window.location.pathname, `/paper/${Buffer.from(identity).toString('base64url')}`));
      assert.equal(window.history.length, 1, 'the redirect replaces the readable address');
    } finally {
      await app.stop();
    }
  });
}

test('a readable paper address keeps its query and fragment through the redirect', async () => {
  const app = await renderApp('/paper/arxiv%3A2401.00001?from=share#abstract');
  try {
    await waitFor(() => assert.equal(window.location.pathname, '/paper/YXJ4aXY6MjQwMS4wMDAwMQ'));
    assert.equal(window.location.search, '?from=share');
    assert.equal(window.location.hash, '#abstract');
    assert.equal(window.history.length, 1);
  } finally {
    await app.stop();
  }
});
