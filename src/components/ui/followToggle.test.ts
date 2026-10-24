import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * One Follow control for everything that can be followed: authors,
 * institutions, projects and topics, all from the Explorer (whose use of it
 * explorerOverlays.test.ts pins).
 */

test('the Follow control is a Toggle drawn like Like and Save: an outline whose icon fills once on and pulses on the press', async () => {
  const jsx = await read('./follow-toggle.tsx');
  const css = stripComments(await read('./follow-toggle.css'));
  assert.match(jsx, /<Toggle\s+variant="outline"\s+className=\{cn\('follow-toggle', compact && 'follow-toggle--compact', className\)\}\s+pressed=\{pressed\}/);
  // Always an icon: a plus to follow, a filled minus once followed.
  assert.match(jsx, /pressed\s*\? <UserCircleMinus [^>]*weight="fill" aria-hidden="true" \/>\s*: <UserCirclePlus [^>]*aria-hidden="true" \/>/);
  // The feed's pulse, on the icon's box (the glyph is swapped mid-pulse),
  // and none under reduced motion.
  assert.match(jsx, /if \(!reducedMotion\) pulseIcon\(iconRef\.current, !pressed\);/);
  // On stays the outline of off, not the toggle's ink fill.
  assert.match(css, /\.follow-toggle,\s*\.follow-toggle\[data-pressed\] \{[^}]*background: var\(--bg-card\);/);
  assert.match(css, /\.follow-toggle \{[^}]*transition:[^;]*background[^;]*transform 0\.16s ease-out;/);
  const squeeze = css.match(/\.follow-toggle:active:not\(:disabled\) \{([^}]*)\}/);
  assert.match(squeeze?.[1] || '', /transform: scale\(0\.97\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.follow-toggle:active:not\(:disabled\) \{\s*transform: none;/);
});
