import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Paper } from '../../models/paper.ts';
import { PAGE_SIZE } from '../../context/feed-pagination.ts';
import { renderFeed, waitFor } from '../../../tests/dom/render-feed.ts';
import { act } from '@testing-library/react';

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
// Longer than the status region's settle delay in feed-container.tsx, and
// shorter than a refresh's shortest spin.
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
 * `papers` the store answers it as soon as it asks. `until` waits for the
 * focus to reach the veil's heading: whileHeld when the test holds the clock.
 */
async function pressTryAgain(view: Awaited<ReturnType<typeof renderFeed>>, papers?: Paper[], until: (check: () => void) => Promise<unknown> = waitFor) {
  const button = tryAgainButton();
  if (papers) view.corpus.answer({ papers, more: false });
  else view.corpus.wait();
  button.focus();
  const reader = listen();
  button.click();
  await until(() => assert.equal(reader.heard()[0], 'focus: Searching for discoveries...'));
  return reader;
}

/**
 * waitFor for a test that holds the clock (mock.timers): waitFor itself
 * settles on a setTimeout, which never fires while the clock is held. Each
 * turn runs the timers due now, never one that waits for the clock to move.
 * The 8-second limit is read from Date, which the test does not hold.
 */
async function whileHeld(check: () => void) {
  const deadline = Date.now() + 8000;
  for (;;) {
    await act(async () => {
      mock.timers.tick(0);
      await new Promise(resolve => { setImmediate(resolve); });
    });
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
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
    // From the feed screen's mount the test holds setTimeout's clock, so the
    // status region settles, and the refresh stops spinning, only when the
    // test moves it, however slow the run. React's scheduler runs on
    // setImmediate and jsdom's animation frames on setInterval, which the
    // test does not hold, so the screen still renders and the veil leaves.
    mock.timers.enable({ apis: ['setTimeout'] });
    view.showContainer();

    // A full first page. After a shorter one the feed asks for the next
    // pages by itself (feed-context.tsx), and with the clock held those loads
    // would still run when the refresh ends, which the tail then announces.
    const page = Array.from({ length: PAGE_SIZE }, (_, index) => ({ ...card, id: `arxiv:2401.${String(index + 1).padStart(5, '0')}` }));
    // The veil leaves with the papers, while the refresh still spins, and
    // the focus moves from its heading to the card.
    reader = await pressTryAgain(view, page, whileHeld);
    await whileHeld(() => assert.ok(document.activeElement?.closest('.feed-snap-item'), 'The focus is on the card.'));
    // The region settles after the papers, while the refresh still spins,
    // and leaves unsaid the wait the heading said.
    await act(async () => { mock.timers.tick(SETTLED_MS); });
    assert.deepEqual(reader.statuses(), []);
    // The refresh ends, and its result is spoken.
    await act(async () => { mock.timers.tick(REFRESH_SPIN_MS); });
    await whileHeld(() => assert.deepEqual(reader?.statuses(), ['status: Papers updated']));
  } finally {
    mock.timers.reset();
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
