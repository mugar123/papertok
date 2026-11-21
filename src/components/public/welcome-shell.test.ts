import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { loadWelcomeShell } from '../../../tests/dom/component-modules.ts';
import { renderErrors, translatePage } from '../../../tests/dom/browser-translation.ts';

// The welcome's main button changes its words between screens and while it
// saves. On a page the browser has translated, the new words must replace the
// translated old ones, not leave them on the button.
test('on a translated welcome, the main button shows its new label when it changes', async () => {
  const { WelcomeShell, ThemeProvider, close } = await loadWelcomeShell();
  try {
    const shell = (label: string) => createElement(ThemeProvider, null, createElement(WelcomeShell, {
      stepKey: 'topics',
      direction: 1,
      still: true,
      dots: { count: 3, index: 1, ariaLabel: 'Progress', label: (index, count) => `Step ${index + 1} of ${count}` },
      primary: { label, onClick() {} },
    }, createElement('h1', { className: 'gw-title' }, 'Pick your areas')));
    const { container, rerender } = render(shell('Continue'));
    const button = screen.getByRole('button', { name: 'Continue' });
    assert.ok(translatePage(container) > 0, 'the translator replaced the page text');

    assert.deepEqual(await renderErrors(() => rerender(shell('Saving…'))), []);
    assert.equal(button.textContent, 'Saving…', 'the button says what it does now');
  } finally {
    cleanup();
    await close();
  }
});

// An area with many topics folds them behind "Show N more", which becomes
// "Show less" once pressed. On a translated page it must say so.
test('on a translated welcome, the topic fold\'s button shows its new label when it opens', async () => {
  const { SubtopicsPicker, close } = await loadWelcomeShell();
  try {
    const picker = (expanded: boolean) => createElement(SubtopicsPicker, {
      selectedAreas: new Set(['physics']),
      selectedTopics: new Set(),
      onToggleTopic() {},
      expandedAreas: new Set(expanded ? ['physics'] : []),
      onToggleExpanded() {},
    });
    const { container, rerender } = render(picker(false));
    const fold = container.querySelector('.gw-more');
    assert.match(fold?.textContent ?? '', /^Show \d+ more$/, 'the fold starts closed');
    assert.ok(translatePage(container) > 0, 'the translator replaced the page text');

    assert.deepEqual(await renderErrors(() => rerender(picker(true))), []);
    assert.equal(fold?.textContent, 'Show less', 'the button says what it does now');
  } finally {
    cleanup();
    await close();
  }
});
