import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * SOURCE tests for the press on the three triggers that open an entity from a
 * card. None of them answered a thumb: their hover sits behind
 * `@media (hover: hover)`, which never fires on a phone, and the page they open
 * does not mount until the feed's 200ms exit has finished. So for the first
 * beat after a tap, nothing at all happened on the card.
 */
test('the author name and the topic chip acknowledge a press', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  // A name mid-sentence dips; a scaled word reads as a glitch.
  assert.match(css, /\.pc-author-link:active \{\s*opacity: 0\.55;\s*\}/);
  assert.match(css, /\.pc-author-link \{[^}]*transition: opacity 0\.12s ease-out;[^}]*\}/);
  // The chip takes the catalog's squeeze.
  assert.match(css, /\.pc-topic-link:active \{\s*transform: scale\(0\.97\);\s*\}/);
});

/**
 * `transition` is a shorthand: a later rule naming only `transform` would drop
 * the colour fades the chip already declares (the trap ThemeToggle.css
 * documents). So `transform` is appended to its existing list.
 */
test('the squeeze is appended to the list the chip already had', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  for (const cls of ['pc-topic-link']) {
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
  assert.ok(blocks.some((b: string) => /\.pc-topic-link:active[^{]*\{\s*transform: none;\s*\}/.test(b)), 'the squeeze is switched off');
  assert.ok(!blocks.some((b: string) => /\.pc-author-link:active/.test(b)), 'the opacity dip is not movement and stays');
});
