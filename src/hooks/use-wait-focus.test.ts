import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaitFocus } from './use-wait-focus.ts';

/**
 * A page that only knows where the focus is. Each element moves the focus to
 * itself when focused, and `blur` is the focus falling to the page body, as
 * it does when the focused element leaves the document.
 */
function page() {
  let active: object | null = null;
  const element = () => {
    const node = { focus() { active = node; } };
    return node;
  };
  return { element, active: () => active, blur() { active = null; } };
}

/** The feed's error with its Try again, pressed from the keyboard. */
function pressedTryAgain() {
  const view = page();
  const memory = createWaitFocus(view.active);
  const tryAgain = view.element();
  memory.attach(tryAgain);
  tryAgain.focus();
  // The reload starts: React detaches the button, then removes it, and the
  // veil with its heading comes in the same commit.
  memory.attach(null);
  view.blur();
  const heading = view.element();
  return { view, memory, heading };
}

const noCard = () => null;

// PR #425 browser check: focus sat on the page body for the whole 10 s wait,
// and stayed there when the error came back.
test('the focus waits on the veil heading while the reload runs', () => {
  const { view, memory, heading } = pressedTryAgain();

  memory.settle(heading, noCard, true);

  assert.equal(view.active(), heading);
});

test('the focus goes back to Try again when the error comes back', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard, true);

  // The veil leaves with its heading; a new Try again comes in its place.
  view.blur();
  const again = view.element();
  memory.attach(again);
  memory.settle(null, noCard, false);

  assert.equal(view.active(), again);
});

test('the focus goes to the card shown when the papers arrive', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard, true);
  const firstControl = view.element();

  // The veil is still fading out with the focus on its heading.
  memory.settle(null, () => firstControl, false);

  assert.equal(view.active(), firstControl);
});

test('a reader who moved on during the wait keeps their focus', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard, true);
  const navLink = view.element();
  navLink.focus();

  memory.settle(heading, noCard, true);
  const again = view.element();
  memory.attach(again);
  memory.settle(null, noCard, false);

  assert.equal(view.active(), navLink);
});

test('a commit with neither a wait nor a place to land keeps the focus owed', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard, true);

  // Following's refresh is over, and its page shows the papers one commit
  // after its empty state.
  view.blur();
  memory.settle(null, noCard, false);
  const firstControl = view.element();
  memory.settle(null, () => firstControl, false);

  assert.equal(view.active(), firstControl);
});

test('a wait shown without its heading keeps the focus owed', () => {
  const { view, memory, heading } = pressedTryAgain();

  // A skeleton card: the load runs, with no heading to wait on.
  memory.settle(null, noCard, true);
  memory.settle(heading, noCard, true);

  assert.equal(view.active(), heading);
});

// Following's Try again found nothing new: its empty state has no retry
// button, and the focus stayed owed until Check for updates, pressed later,
// moved it to the wait's heading and then to the first card.
test('a later wait leaves the focus alone after a load that ended with nowhere to land', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard, true);
  view.blur();
  memory.settle(null, noCard, false);

  const checkForUpdates = view.element();
  checkForUpdates.focus();
  view.blur();
  memory.settle(view.element(), noCard, true);
  const firstControl = view.element();
  memory.settle(null, () => firstControl, false);

  assert.equal(view.active(), null);
});

// A card control under an inert container ignores focus(): the focus was
// then never owed again, and fell to the page as the veil left.
test('a place that refuses the focus leaves it owed for the next commit', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard, true);
  const inertLink = { focus() {} };
  memory.settle(null, () => inertLink, false);

  view.blur();
  const firstControl = view.element();
  memory.settle(null, () => firstControl, false);

  assert.equal(view.active(), firstControl);
});

test('a retry button that leaves without the focus moves nothing', () => {
  const view = page();
  const memory = createWaitFocus(view.active);
  const tryAgain = view.element();
  memory.attach(tryAgain);

  memory.attach(null);
  const heading = view.element();
  memory.settle(heading, noCard, true);
  memory.settle(null, () => view.element(), false);

  assert.equal(view.active(), null);
});

test('the focus lands once per departure', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard, true);
  const firstControl = view.element();
  memory.settle(null, () => firstControl, false);

  // The reader leaves the card; a later commit moves nothing.
  view.blur();
  memory.settle(null, () => view.element(), false);

  assert.equal(view.active(), null);
});
