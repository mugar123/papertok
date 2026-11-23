import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { loadWelcomeProjectSupport } from '../../../tests/dom/component-modules.ts';
import { renderErrors, translatePage } from '../../../tests/dom/browser-translation.ts';

// The welcome's last screen plays a GitHub page being starred: 2.45 s in, the
// star's icon is replaced and "Star" becomes "Starred". On a page the browser
// has translated, that must not take the welcome down (facebook/react#11538).
// The demo only plays where motion is allowed, so this browser allows it,
// before the motion library first reads the preference.
test('on a translated welcome, the GitHub star demo stars without a crash', async () => {
  const reducedMotion = window.matchMedia;
  window.matchMedia = query => ({ ...reducedMotion(query), matches: false });
  const { WelcomeProjectSupport, close } = await loadWelcomeProjectSupport();
  try {
    const { container } = render(createElement(WelcomeProjectSupport));
    const star = container.querySelector('.gw-gh-star');
    assert.ok(star, 'the demo shows the star button');
    assert.equal(star.hasAttribute('data-starred'), false, 'the demo starts unstarred');
    assert.ok(translatePage(container) > 0, 'the translator replaced the page text');

    assert.deepEqual(await renderErrors(() => new Promise(resolve => setTimeout(resolve, 3000))), [], 'nothing is thrown when the star is pressed');
    assert.equal(star.hasAttribute('data-starred'), true, 'the demo starred the page');
    assert.match(star.textContent ?? '', /Starred/, 'the button says Starred');
  } finally {
    cleanup();
    window.matchMedia = reducedMotion;
    await close();
  }
});
