import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * One Follow control for everything that can be followed: authors,
 * institutions, projects and topics, all from the Explorer (whose use of it
 * explorerOverlays.test.ts pins).
 */

test('the Follow control is a Toggle: ink while it invites, a chip with a check once on', async () => {
  const jsx = await read('./follow-toggle.tsx');
  const css = stripComments(await read('./follow-toggle.css'));
  assert.match(jsx, /<Toggle\s+variant="outline"\s+className=\{cn\('follow-toggle', className\)\}\s+pressed=\{pressed\}/);
  assert.match(jsx, /<Check size=\{14\} aria-hidden="true" \/>/);
  assert.match(css, /\.follow-toggle \{[^}]*min-width: 96px;[^}]*background: var\(--accent-primary\);/);
  assert.match(css, /\.follow-toggle\[data-pressed\] \{[^}]*background: var\(--bg-card\);/);
  // A colour fade AND the squeeze: one transition list, so neither drops the other.
  assert.match(css, /\.follow-toggle \{[^}]*transition:[^;]*background[^;]*transform 0\.16s ease-out;/);
  const squeeze = css.match(/\.follow-toggle:active:not\(:disabled\) \{([^}]*)\}/);
  assert.match(squeeze?.[1] || '', /transform: scale\(0\.97\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.follow-toggle:active:not\(:disabled\) \{\s*transform: none;/);
});
