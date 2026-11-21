import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '../../../tests/dom/render-app.ts';
// After render-app, which makes the jsdom browser these queries read.
import { screen, within } from '@testing-library/react';

// ENG-218: a key that names no paper made no request, so Retry had nothing to repeat.
test('an address that names no paper says so, with Back and Home and no Retry', async () => {
  const app = await renderApp('/paper/foo:bar');
  try {
    const heading = await screen.findByRole('heading', { level: 1, name: 'We could not find this paper' });
    const state = heading.parentElement;
    assert.ok(state);
    assert.ok(within(state).getByRole('button', { name: 'Back' }));
    assert.ok(within(state).getByRole('button', { name: 'Home' }));
    assert.equal(within(state).queryByRole('button', { name: 'Retry' }), null);
    assert.equal(window.location.pathname, '/paper/foo:bar', 'the address is left as written');
  } finally {
    await app.stop();
  }
});

// The key is the canonical one for doi:10.1000/abc. The stub Worker answers
// nothing (it has no route for the OpenAlex lookup of this DOI), so the lookup
// fails as it does when the reader is offline. Stubbing that route would load
// the paper instead and end this test.
test('a paper that fails to load offers Retry', async () => {
  const app = await renderApp('/paper/ZG9pOjEwLjEwMDAvYWJj');
  try {
    const heading = await screen.findByRole('heading', { level: 1, name: 'The paper could not be loaded' });
    const state = heading.parentElement;
    assert.ok(state);
    assert.ok(within(state).getByRole('button', { name: 'Retry' }));
    assert.ok(within(state).getByRole('button', { name: 'Back' }));
  } finally {
    await app.stop();
  }
});
