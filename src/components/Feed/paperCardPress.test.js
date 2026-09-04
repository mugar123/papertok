import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * SOURCE tests for the press on the three triggers that open an entity from a
 * card. None of them answered a thumb: their hover sits behind
 * `@media (hover: hover)`, which never fires on a phone, and the page they open
 * does not mount until the feed's 200ms exit has finished. So for the first
 * beat after a tap, nothing at all happened on the card.
 */
test('the author name, the topic chip and the project badge acknowledge a press', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  // A name mid-sentence dips; a scaled word reads as a glitch.
  assert.match(css, /\.pc-author-link:active \{\s*opacity: 0\.55;\s*\}/);
  assert.match(css, /\.pc-author-link \{[^}]*transition: opacity 0\.12s ease-out;[^}]*\}/);
  // The chip and the badge take the catalog's squeeze.
  assert.match(css, /\.pc-topic-link:active \{\s*transform: scale\(0\.97\);\s*\}/);
  assert.match(css, /\.pc-project-badge:active \{\s*transform: scale\(0\.97\);\s*\}/);
});

/**
 * `transition` is a shorthand: a later rule naming only `transform` would drop
 * the colour fades these two already declare (the trap ThemeToggle.css
 * documents). So `transform` is appended to their existing lists.
 */
test('the squeeze is appended to the lists the chip and the badge already had', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  for (const cls of ['pc-topic-link', 'pc-project-badge']) {
    const rule = css.match(new RegExp(`^\\.${cls} \\{([^}]*)\\}`, 'm'));
    assert.ok(rule, `${cls} has a base rule`);
    const transition = rule[1].match(/transition:([^;]*);/);
    assert.ok(transition, `${cls} still declares a transition`);
    assert.match(transition[1], /transform 0\.16s ease-out/, `${cls} gained the press`);
    assert.match(transition[1], /border-color var\(--transition-fast\)/, `${cls} kept its colour fade`);
  }
});

test('reduced motion keeps the dip and drops the squeeze', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
  assert.ok(blocks.some((b) => /\.pc-topic-link:active,\s*\.pc-project-badge:active \{\s*transform: none;\s*\}/.test(b)), 'the squeeze is switched off');
  assert.ok(!blocks.some((b) => /\.pc-author-link:active/.test(b)), 'the opacity dip is not movement and stays');
});
