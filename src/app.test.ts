import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '../tests/dom/render-app.ts';
import { waitFor } from '@testing-library/react';

// ENG-44: a paper's page moved from /public/paper/:key to /paper/:key. Visits
// that never ask the server for the old address are redirected by the route.
test('the legacy paper address redirects to the paper, keeping its query and fragment, in the same history entry', async () => {
  const app = await renderApp('/public/paper/arxiv%3A2401.00001?from=share#abstract');
  try {
    await waitFor(() => assert.equal(window.location.pathname, '/paper/arxiv%3A2401.00001'));
    assert.equal(window.location.search, '?from=share');
    assert.equal(window.location.hash, '#abstract');
    assert.equal(window.history.length, 1);
  } finally {
    await app.stop();
  }
});
