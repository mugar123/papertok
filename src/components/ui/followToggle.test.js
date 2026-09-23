import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * One Follow control for everything that can be followed. The public profile
 * used to carry its own — taller, wider, an icon per state and a red
 * "Unfollow" on hover — beside the Explorer's compact ink toggle, so following
 * a person and following an institution looked like two different actions.
 */

test('the Follow control is a Toggle: ink while it invites, a chip with a check once on', async () => {
  const jsx = await read('./follow-toggle.jsx');
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

test('the Explorer and the public profile both use it, and neither styles its own', async () => {
  const explorer = await read('../Explorer/EntityExplorer.jsx');
  const profile = await read('../Public/PublicProfilePage.jsx');
  const profileCss = stripComments(await read('../Public/PublicProfilePage.css'));
  assert.match(explorer, /<FollowToggle\s/);
  assert.match(profile, /<FollowToggle\s+pressed=\{following\}/);
  assert.doesNotMatch(profileCss, /\.profile-follow-button/);
  assert.doesNotMatch(profile, /UserPlus|UserX|is-unfollow-intent/);
});
