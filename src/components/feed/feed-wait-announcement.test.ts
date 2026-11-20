import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Paper } from '../../models/paper.ts';
import { renderFeed, waitFor } from '../../../tests/dom/render-feed.ts';

// ENG-177: a wait is announced once. The status regions' words are pure
// steps in feed-loading-state.test.ts; these tests render the feed screen, so
// what the regions and the focus carry over a wait's states is checked too.

// A synthetic card, enough for the feed to show it.
const card: Paper = {
  id: 'arxiv:2401.00001',
  sources: { primary: 'arxiv', enrichedBy: [] },
  title: 'A synthetic paper for the feed tests',
  abstract: 'Synthetic abstract.',
  authors: ['A. Author'],
  year: 2024,
};

// The feed screen's status region, and the one at the end of its cards.
const STATUS_REGIONS = ':is(.feed-wrapper, .feed-empty) > span[role="status"], .feed-snap-item--tail [role="status"]';
// Longer than the status region's settle delay in feed-container.tsx.
const SETTLED_MS = 500;
// Longer than a refresh's shortest spin (refreshFeed in feed-context.tsx), so
// the refresh ends with its load.
const REFRESH_SPIN_MS = 1000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test.afterEach(() => {
  // A card a test answered is kept as the account's saved feed.
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * What a screen reader is given from now on, in order: the text of each
 * element the focus moves to, and each new text of the feed's status regions.
 */
function listen() {
  const heard: string[] = [];
  const texts = new Map<Element, string>();
  const read = () => {
    for (const region of document.querySelectorAll(STATUS_REGIONS)) {
      const text = region.textContent ?? '';
      if (texts.get(region) !== text && text) heard.push(`status: ${text}`);
      texts.set(region, text);
    }
  };
  for (const region of document.querySelectorAll(STATUS_REGIONS)) texts.set(region, region.textContent ?? '');
  const observer = new MutationObserver(read);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  const onFocus = (event: FocusEvent) => { if (event.target instanceof Element) heard.push(`focus: ${event.target.textContent}`); };
  document.addEventListener('focusin', onFocus);
  return {
    heard: () => [...heard],
    statuses: () => heard.filter(entry => entry.startsWith('status: ')),
    stop: () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocus);
    },
  };
}

function tryAgainButton() {
  const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === 'Try again');
  assert.ok(button, 'The error screen shows Try again.');
  return button;
}

/**
 * The reader presses Try again from the keyboard. The new load waits, or with
 * `papers` the store answers it as soon as it asks.
 */
async function pressTryAgain(view: Awaited<ReturnType<typeof renderFeed>>, papers?: Paper[]) {
  const button = tryAgainButton();
  if (papers) view.corpus.answer({ papers, more: false });
  else view.corpus.wait();
  button.focus();
  const reader = listen();
  button.click();
  await waitFor(() => assert.equal(reader.heard()[0], 'focus: Searching for discoveries...'));
  return reader;
}

test('after Try again, the focused heading says the wait and the status region does not repeat it', async () => {
  const view = await renderFeed({ container: true });
  let reader: ReturnType<typeof listen> | null = null;
  try {
    await view.corpus.requested();
    view.corpus.refuse(503, 'AUTH_UNAVAILABLE');
    // The automatic retry fails too, and the error screen offers Try again.
    await waitFor(tryAgainButton, { timeout: 8000 });

    reader = await pressTryAgain(view);
    await pause(REFRESH_SPIN_MS);
    assert.deepEqual(reader.heard(), ['focus: Searching for discoveries...']);

    // The papers end the wait and the refresh together: the focus moves to the
    // card, and the result is spoken.
    view.corpus.answer({ papers: [card], more: false });
    await waitFor(() => assert.deepEqual(reader?.statuses(), ['status: Papers updated']), { timeout: 8000 });
    assert.ok(document.activeElement?.closest('.feed-snap-item'), 'The focus is on the card.');
  } finally {
    reader?.stop();
    await view.stop();
  }
});

test('a Try again pressed in an error screen\'s first moments is not announced again once the region settles', async () => {
  // The feed failed while the reader was elsewhere, and the screen opens on its error.
  const view = await renderFeed();
  let reader: ReturnType<typeof listen> | null = null;
  try {
    await view.corpus.requested();
    view.corpus.refuse(503, 'AUTH_UNAVAILABLE');
    await waitFor(() => assert.equal(view.appErrors().length, 2), { timeout: 8000 });
    view.showContainer();

    reader = await pressTryAgain(view);
    await pause(SETTLED_MS);
    assert.deepEqual(reader.heard(), ['focus: Searching for discoveries...']);
  } finally {
    reader?.stop();
    await view.stop();
  }
});

test('papers that end that wait before the region settles do not let it announce the wait late', async () => {
  const view = await renderFeed();
  let reader: ReturnType<typeof listen> | null = null;
  try {
    await view.corpus.requested();
    view.corpus.refuse(503, 'AUTH_UNAVAILABLE');
    await waitFor(() => assert.equal(view.appErrors().length, 2), { timeout: 8000 });
    view.showContainer();

    // The veil leaves with the papers, while the refresh still spins. This
    // covers the late write only when the papers land before the region
    // settles; on a slower run the heading still holds the focus then, the
    // case the previous test covers.
    reader = await pressTryAgain(view, [card]);
    await waitFor(() => assert.deepEqual(reader?.statuses(), ['status: Papers updated']), { timeout: 8000 });
    await pause(SETTLED_MS);
    assert.deepEqual(reader.statuses(), ['status: Papers updated']);
  } finally {
    reader?.stop();
    await view.stop();
  }
});

test('a refresh over cards is announced once, by the feed\'s status, not also as more papers loading', async () => {
  const view = await renderFeed({ container: true });
  let reader: ReturnType<typeof listen> | null = null;
  try {
    await view.corpus.requested();
    view.corpus.answer({ papers: [card], more: false });
    await waitFor(() => assert.equal(view.feed().papers.length, 1), { timeout: 8000 });
    await pause(SETTLED_MS);

    view.corpus.wait();
    reader = listen();
    void view.feed().refreshFeed();
    await pause(SETTLED_MS);
    assert.deepEqual(reader.heard(), ['status: Refreshing papers…']);

    view.corpus.answer({ papers: [card], more: false });
    await waitFor(() => assert.deepEqual(reader?.heard(), ['status: Refreshing papers…', 'status: Papers updated']), { timeout: 8000 });
  } finally {
    reader?.stop();
    await view.stop();
  }
});
