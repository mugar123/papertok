import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { loadProviderSignIn } from '../../../tests/dom/component-modules.ts';
import { renderErrors, translatePage } from '../../../tests/dom/browser-translation.ts';

// The welcome opens with "Preparing sign-in…" under the GitHub and Google
// buttons while the sign-in window gets ready. A browser translating the page
// on arrival replaces that line's text node with its own <font>; the line then
// changes when the wait ends, and that must not take the page down
// (facebook/react#11538).
test('a translated "Preparing sign-in…" line can end its wait, fail and be retried without a crash', async () => {
  const { PreparingNote, close } = await loadProviderSignIn();
  try {
    const note = (state: 'preparing' | 'ready' | 'failed') => createElement(PreparingNote, { id: 'note', state, onRetry() {}, keepLine: false });
    const { container, rerender } = render(note('preparing'));
    assert.ok(translatePage(container) > 0, 'the translator replaced the line');

    assert.deepEqual(await renderErrors(() => rerender(note('failed'))), [], 'the wait fails');
    assert.match(container.textContent ?? '', /Sign-in could not load\./);
    translatePage(container);
    assert.deepEqual(await renderErrors(() => rerender(note('preparing'))), [], 'Try again restarts it');
    translatePage(container);
    assert.deepEqual(await renderErrors(() => rerender(note('ready'))), [], 'the wait ends');
    assert.equal(container.querySelector('[role="status"]')?.textContent, 'Sign-in ready.');
  } finally {
    cleanup();
    await close();
  }
});

// The welcome's alert paragraph holds the one-account-per-email note while a
// collision stands. On a translated page the note's words are the translator's
// nodes; the next press clears the note, and a redirect's note (no address)
// can be followed by a popup's (with one). Neither change may take the page
// down, and the address is left untranslated.
test('a translated "already signs in another way" note can gain its address and be cleared without a crash', async () => {
  const { CollisionNote, close } = await loadProviderSignIn();
  try {
    const alert = (email: string | null) => createElement('p', { role: 'alert' }, email === null ? '' : createElement(CollisionNote, { email }));
    const { container, rerender } = render(alert(''));
    assert.ok(translatePage(container) > 0, 'the translator replaced the note');

    assert.deepEqual(await renderErrors(() => rerender(alert('reader@example.org'))), [], 'the note gains its address');
    translatePage(container);
    assert.equal(container.querySelector('strong')?.textContent, 'reader@example.org', 'the address is not translated');
    assert.deepEqual(await renderErrors(() => rerender(alert(null))), [], 'the note is cleared');
    assert.equal(container.textContent, '');
  } finally {
    cleanup();
    await close();
  }
});
