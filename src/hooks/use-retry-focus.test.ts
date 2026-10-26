import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryFocus } from './use-retry-focus.ts';

/**
 * A page that only knows where the focus is. Each element moves the focus to
 * itself when focused, and `blur` is the focus falling to the page body, as
 * it does when the focused element leaves the document.
 */
function page() {
  let active: object | null = null;
  const element = (isConnected = true) => {
    const node = { isConnected, focus() { active = node; } };
    return node;
  };
  return { element, active: () => active, blur() { active = null; } };
}

/** Try again and the provider button it is for, as the sign-in dialog shows them. */
function failedLoad() {
  const view = page();
  const tryAgain = view.element();
  const provider = view.element();
  const memory = createRetryFocus(view.active);
  memory.attach(tryAgain);
  return { view, tryAgain, provider, memory };
}

test('a slow load that ends under Try again hands the focus to the button it was for', () => {
  const { view, tryAgain, provider, memory } = failedLoad();
  tryAgain.focus();
  memory.focused(provider);

  // The load ends by itself: React detaches the button, then removes it.
  memory.attach(null);
  view.blur();
  memory.settle(false);

  assert.equal(view.active(), provider);
});

test('Try again leaving while the reader is elsewhere leaves their focus there', () => {
  const { view, tryAgain, provider, memory } = failedLoad();
  tryAgain.focus();
  memory.focused(provider);
  const field = view.element();
  field.focus();

  memory.attach(null);
  memory.settle(false);

  assert.equal(view.active(), field);
});

test('a render that keeps Try again moves no focus', () => {
  const { view, tryAgain, provider, memory } = failedLoad();
  tryAgain.focus();
  memory.focused(provider);

  memory.settle(true);

  assert.equal(view.active(), tryAgain);
});

test('a button that left the page with Try again does not take the focus', () => {
  const { view, tryAgain, memory } = failedLoad();
  const gone = view.element(false);
  tryAgain.focus();
  memory.focused(gone);

  memory.attach(null);
  view.blur();
  memory.settle(false);

  assert.equal(view.active(), null);
});

test('the focus moves once per departure', () => {
  const { view, tryAgain, provider, memory } = failedLoad();
  tryAgain.focus();
  memory.focused(provider);
  memory.attach(null);
  view.blur();
  memory.settle(false);
  const field = view.element();
  field.focus();

  // A later commit, with Try again still gone.
  memory.settle(false);

  assert.equal(view.active(), field);
});
