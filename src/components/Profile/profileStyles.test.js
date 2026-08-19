import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A `var(--token)` that no stylesheet defines resolves to nothing, and the
 * declaration is dropped in silence — no console warning, no build error, and
 * the page merely looks slightly wrong. F1 shipped four of these (`--space-7`,
 * `--fs-md`, `--danger`, `--success`) and they were only caught by looking at
 * the deployed page.
 *
 * Scoped to the two stylesheets F1 owns. A repo-wide version would need an
 * allowlist for the locally-scoped properties components inject through
 * `style={{ '--stagger-index': n }}`, which are not design tokens at all.
 */
const OWNED = [
  '../Profile/ProfilePage.css',
  '../Public/PublicProfilePage.css',
  '../Public/FollowSheet.css',
];

test('every design token used by the profile screens is actually defined', async () => {
  const variables = await readFile(new URL('../../styles/variables.css', import.meta.url), 'utf8');
  const defined = new Set(
    (variables.match(/^\s*(--[a-z0-9-]+)\s*:/gim) || [])
      .map(line => line.trim().replace(/\s*:$/, '')),
  );
  assert.ok(defined.size > 20, 'expected to have parsed the design tokens');

  const missing = [];
  for (const path of OWNED) {
    const stylesheet = await readFile(new URL(path, import.meta.url), 'utf8');
    for (const usage of stylesheet.match(/var\(\s*--[a-z0-9-]+/gi) || []) {
      const token = usage.replace(/var\(\s*/, '');
      if (!defined.has(token)) missing.push(`${path.split('/').pop()}: ${token}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'undefined design tokens are dropped silently');
});
