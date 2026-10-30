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

  memory.settle(heading, noCard);

  assert.equal(view.active(), heading);
});

test('the focus goes back to Try again when the error comes back', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard);

  // The veil leaves with its heading; a new Try again comes in its place.
  view.blur();
  const again = view.element();
  memory.attach(again);
  memory.settle(null, noCard);

  assert.equal(view.active(), again);
});

test('the focus goes to the card shown when the papers arrive', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard);
  const firstControl = view.element();

  // The veil is still fading out with the focus on its heading.
  memory.settle(null, () => firstControl);

  assert.equal(view.active(), firstControl);
});

test('a reader who moved on during the wait keeps their focus', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard);
  const navLink = view.element();
  navLink.focus();

  memory.settle(heading, noCard);
  const again = view.element();
  memory.attach(again);
  memory.settle(null, noCard);

  assert.equal(view.active(), navLink);
});

test('a commit with neither a wait nor a place to land keeps the focus owed', () => {
  const { view, memory } = pressedTryAgain();

  memory.settle(null, noCard);
  const firstControl = view.element();
  memory.settle(null, () => firstControl);

  assert.equal(view.active(), firstControl);
});

test('a retry button that leaves without the focus moves nothing', () => {
  const view = page();
  const memory = createWaitFocus(view.active);
  const tryAgain = view.element();
  memory.attach(tryAgain);

  memory.attach(null);
  const heading = view.element();
  memory.settle(heading, noCard);
  memory.settle(null, () => view.element());

  assert.equal(view.active(), null);
});

test('the focus lands once per departure', () => {
  const { view, memory, heading } = pressedTryAgain();
  memory.settle(heading, noCard);
  const firstControl = view.element();
  memory.settle(null, () => firstControl);

  // The reader leaves the card; a later commit moves nothing.
  view.blur();
  memory.settle(null, () => view.element());

  assert.equal(view.active(), null);
});
