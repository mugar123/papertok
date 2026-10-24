import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPLORER_AUTO_PAGES, explorerListState, explorerPageAllowance } from '../../utils/entityExplorer.ts';
import { authorsSentinelMounted, papersFootReport, papersSentinelMounted } from './explorerListFoot.ts';

/**
 * A papers list whose every page leaves the foot on screen (the filters
 * emptied it, or it was short), wired the way EntityExplorer wires it: the
 * sentinel's report goes through `papersFootReport`, and a request spends
 * `explorerPageAllowance` or waits for "Keep looking".
 */
function papersList() {
  const list = { page: 1, autoPagesLeft: EXPLORER_AUTO_PAGES, footHidden: false, awaitingReader: false };
  const requestNextPage = (byReader: boolean) => {
    const left = explorerPageAllowance(list.autoPagesLeft, { byReader });
    if (left === null) {
      list.awaitingReader = true;
      return;
    }
    list.autoPagesLeft = left;
    list.footHidden = false;
    list.page += 1;
  };
  const observe = (isIntersecting: boolean) => {
    const mounted = papersSentinelMounted({
      publicMode: false, awaitingReader: list.awaitingReader, hasMore: true, rowsSettled: true, rows: 3, isFetchingMore: false,
    });
    if (!mounted) return;
    const report = papersFootReport({ isIntersecting, hasMore: true, isLoading: false, isFetchingMore: false, footHidden: list.footHidden });
    if (report === 'left') list.footHidden = true;
    else if (report) requestNextPage(report === 'reader');
  };
  return { list, observe };
}

test('a foot that stays on screen loads two pages on its own, then waits for the reader', () => {
  const { list, observe } = papersList();
  // Every landed page mounts a new observer, which reports the foot where it is.
  for (let landed = 0; landed < 10; landed += 1) observe(true);
  assert.equal(list.page, 3);
  assert.equal(list.awaitingReader, true);
});

test('one scroll to the foot costs at most three pages', () => {
  const { list, observe } = papersList();
  observe(false); // The first page lands with its foot below the fold.
  observe(true); // The reader scrolls to it.
  for (let landed = 0; landed < 10; landed += 1) observe(true);
  assert.equal(list.page, 4, 'one page for the reader, two more for the list');
  assert.equal(list.awaitingReader, true);
});

test('a foot pushed off screen by a loading list is not the reader scrolling', () => {
  assert.equal(papersFootReport({ isIntersecting: false, hasMore: true, isLoading: true, isFetchingMore: false, footHidden: false }), null);
  assert.equal(papersFootReport({ isIntersecting: false, hasMore: true, isLoading: false, isFetchingMore: true, footHidden: false }), null);
  assert.equal(papersFootReport({ isIntersecting: true, hasMore: true, isLoading: false, isFetchingMore: true, footHidden: true }), null);
  assert.equal(papersFootReport({ isIntersecting: true, hasMore: false, isLoading: false, isFetchingMore: false, footHidden: true }), null);
});

test('a guest mounts neither sentinel and the list never asks for page 2 on its own', () => {
  assert.equal(papersSentinelMounted({
    publicMode: true, awaitingReader: false, hasMore: true, rowsSettled: true, rows: 2, isFetchingMore: false,
  }), false);
  assert.equal(authorsSentinelMounted({ publicMode: true, hasMore: true, rows: 2, isFetchingMore: false }), false);
  assert.equal(explorerListState({ rows: 0, hasMore: true, publicMode: true }), 'empty');

  assert.equal(papersSentinelMounted({
    publicMode: false, awaitingReader: false, hasMore: true, rowsSettled: true, rows: 2, isFetchingMore: false,
  }), true);
  assert.equal(authorsSentinelMounted({ publicMode: false, hasMore: true, rows: 2, isFetchingMore: false }), true);
});

test('the papers sentinel waits for the rows already fetched and gives way to "Keep looking"', () => {
  const ready = { publicMode: false, awaitingReader: false, hasMore: true, rowsSettled: true, rows: 2, isFetchingMore: false };
  assert.equal(papersSentinelMounted({ ...ready, rowsSettled: false }), false);
  assert.equal(papersSentinelMounted({ ...ready, awaitingReader: true }), false);
  assert.equal(papersSentinelMounted({ ...ready, rows: 0 }), false);
  assert.equal(papersSentinelMounted({ ...ready, rows: 0, isFetchingMore: true }), true);
});
