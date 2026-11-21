import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sourceFeedFailure } from './source-feed-failure.ts';
import type { Paper } from '../models/paper.ts';
import { renderFeed, waitFor } from '../../tests/dom/render-feed.ts';

// ENG-116: a failed feed load owes one `app_error`, sent when the failed
// attempt is on the reader's screen. The pure steps are in
// feed-load-failure.test.ts; these tests render the provider, so the wiring that
// feeds them its screen and its failures is checked too.

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

const OUTAGE = { kind: 'feed_load_failed', reason: 'server', status: 503, error_code: 'AUTH_UNAVAILABLE' };

// A synthetic card, enough for the provider to restore and dismiss it.
const card: Paper = {
  id: 'arxiv:2401.00001',
  sources: { primary: 'arxiv', enrichedBy: [] },
  title: 'A synthetic paper for the feed tests',
  abstract: 'Synthetic abstract.',
  authors: ['A. Author'],
  year: 2024,
};

const quiet = () => new Promise(resolve => setTimeout(resolve, 100));

test('a feed that fails on entry and again on its retry sends one app_error per attempt, none from the screen', async () => {
  const view = await renderFeed({ container: true });
  try {
    await view.corpus.requested();
    view.corpus.refuse(503, 'AUTH_UNAVAILABLE');
    await waitFor(() => assert.deepEqual(view.appErrors(), [OUTAGE]));
    // The retry, after its pause, fails too. Only then does the feed screen show
    // the error.
    await waitFor(() => assert.deepEqual(view.appErrors(), [OUTAGE, OUTAGE]), { timeout: 8000 });
    await quiet();
    assert.deepEqual(view.appErrors(), [OUTAGE, OUTAGE]);
  } finally {
    await view.stop();
  }
});

const loadsStarted = (view: Awaited<ReturnType<typeof renderFeed>>) =>
  view.feedLoadsStarted().map(params => [params?.load_type, params?.attempt]);

for (const action of ['Try again', 'Check again']) {
  test(`${action} records a manual retry`, async () => {
    const view = await renderFeed({ container: true });
    try {
      await view.corpus.requested();
      if (action === 'Try again') view.corpus.refuse(503, 'AUTH_UNAVAILABLE');
      else view.corpus.answer({ papers: [], more: false });
      const button = await waitFor(() => {
        const retry = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === action);
        assert.ok(retry);
        return retry;
      }, { timeout: 8000 });
      view.corpus.answer({ papers: [card], more: false });
      button.click();
      await waitFor(() => assert.deepEqual(loadsStarted(view).at(-1), ['refresh', 'manual_retry']));
      await waitFor(() => assert.deepEqual(view.feed().papers.map(paper => paper.id), [card.id]));
    } finally {
      await view.stop();
    }
  });
}

test('a failure while the reader is off /feed is sent when they return', async () => {
  const view = await renderFeed();
  try {
    await view.corpus.requested();
    view.showFeed(false);
    view.corpus.refuse(503, 'AUTH_UNAVAILABLE');
    await waitFor(() => assert.equal(view.feed().error, 'FEED_LOAD_FAILED'));
    await quiet();
    assert.deepEqual(view.appErrors(), []);

    view.showFeed(true);
    await waitFor(() => assert.deepEqual(view.appErrors(), [OUTAGE]));
  } finally {
    await view.stop();
  }
});

test('a failure behind cards is sent when the last card is dismissed', async () => {
  const view = await renderFeed({ cards: [card] });
  try {
    await waitFor(() => assert.deepEqual(view.feed().papers.map(paper => paper.id), [card.id]));
    void view.feed().refreshFeed();
    await view.corpus.requested();
    assert.deepEqual(loadsStarted(view), [['refresh', 'original']]);
    view.corpus.refuse(503, 'AUTH_UNAVAILABLE');
    await waitFor(() => assert.equal(view.feed().error, 'FEED_LOAD_FAILED'));
    await quiet();
    assert.deepEqual(view.appErrors(), []);

    await view.feed().markNotInterested(card);
    await waitFor(() => assert.deepEqual(view.appErrors(), [OUTAGE]));
  } finally {
    await view.stop();
  }
});

test('a source reports once when its failed screen opens, even across remounts', async () => {
  const event = { kind: 'feed_load_failed' };
  const failure = sourceFeedFailure('FOLLOWING_LOAD_FAILED');
  const source = { papers: [], loading: false, error: failure.error, takeFailureReport: failure.takeReport };
  const view = await renderFeed({ source });
  try {
    assert.deepEqual(view.appErrors(), []);
    view.showContainer();
    await waitFor(() => assert.deepEqual(view.appErrors(), [event]));
    view.showContainer(false);
    view.showContainer();
    await quiet();
    assert.deepEqual(view.appErrors(), [event]);

    source.takeFailureReport = sourceFeedFailure('FOLLOWING_LOAD_FAILED').takeReport;
    view.showContainer();
    await waitFor(() => assert.deepEqual(view.appErrors(), [event, event]));
  } finally {
    await view.stop();
  }
});
