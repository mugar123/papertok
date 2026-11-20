import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CustomFeedsContext, type CustomFeedsValue } from '../context/custom-feeds-context.ts';
import { usePageTransitionCustom } from './use-page-transition-custom.ts';

const unused = () => { throw new Error('Navigation must not mutate custom feeds'); };
const feeds: CustomFeedsValue = {
  feeds: [], status: 'ready', refreshRequest: null,
  createFeed: unused, updateFeed: unused, deleteFeed: unused, moveFeed: unused,
  openFeedEditor: unused, confirmDeleteFeed: unused, requestRefresh: unused, retry: unused,
};

function navigation(state: { pageMotion?: string }) {
  const results: ReturnType<typeof usePageTransitionCustom>[] = [];
  function ReadNavigation() {
    results.push(usePageTransitionCustom());
    return null;
  }
  renderToString(createElement(MemoryRouter, {
    initialEntries: [{ pathname: '/lists', state }],
  }, createElement(CustomFeedsContext.Provider, { value: feeds }, createElement(ReadNavigation))));
  return results[0];
}

test('returning to a list without motion still carries the history direction for scroll restoration', () => {
  assert.deepEqual(navigation({ pageMotion: 'still' }), {
    direction: 0, lateral: false, still: true, historyDirection: -1,
  });
});

test('animated returns carry the same history direction', () => {
  assert.deepEqual(navigation({}), { direction: -1, lateral: false, historyDirection: -1 });
});
