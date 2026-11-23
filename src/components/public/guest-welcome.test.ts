import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '../../../tests/dom/render-app.ts';
// After render-app, which makes the jsdom browser these queries read.
import { screen } from '@testing-library/react';
import { renderErrors, translatePage } from '../../../tests/dom/browser-translation.ts';

// A visitor translates the welcome with the browser, opens the sign-in options
// and presses GitHub: the button's mark turns into a spinner beside its
// translated label, and back once the attempt ends. Neither swap may take the
// page down (facebook/react#11538).
test('on a translated welcome, pressing Continue with GitHub swaps its icon without a crash', async () => {
  const app = await renderApp('/onboarding');
  // The stubbed sign-in fails, and the app logs why.
  const logError = console.error;
  console.error = () => {};
  try {
    const github = await screen.findByRole('button', { name: 'Continue with GitHub' });
    screen.getByRole('button', { name: 'I already have an account' }).click();
    assert.ok(translatePage(document.body) > 0, 'the translator replaced the page text');

    let spinnerShown = false;
    const observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => node instanceof window.Element && node.matches('.auth-spinner')))) spinnerShown = true;
    });
    observer.observe(github, { childList: true, subtree: true });
    // The press, then the attempt failing against the stubbed Firebase: each
    // wait is its own `act`, so the renders it causes are committed in it.
    const errors = await renderErrors(() => github.click());
    for (let waits = 0; github.querySelector('.auth-spinner') && waits < 100; waits += 1) {
      errors.push(...await renderErrors(() => new Promise(resolve => setTimeout(resolve, 50))));
    }
    observer.disconnect();

    assert.deepEqual(errors, [], 'nothing is thrown while the icon swaps');
    assert.ok(spinnerShown, 'the spinner showed while the attempt ran');
    assert.equal(github.querySelector('.auth-spinner'), null, 'the mark is back once the attempt ended');
    assert.match(github.textContent ?? '', /\[es\] Continue with GitHub/, 'the label stays translated');
  } finally {
    console.error = logError;
    await app.stop();
  }
});
