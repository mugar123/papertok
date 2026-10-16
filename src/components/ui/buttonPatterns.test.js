import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

/**
 * The two patterned buttons draw the eye, and a pattern on every screen stops
 * being one: `outline` turned halftone once and was on 56 buttons within a day.
 * So they are asked for by name and only where design.md allows them. A new
 * place is a design decision: add it here and to design.md together.
 */
const ALLOWED = new Map([
  ['engraved', ['components/Public/GuestWelcome.jsx', 'components/Public/WelcomeShell.jsx']],
  ['halftone', ['components/Public/GuestWelcome.jsx']],
]);
const HALFTONE_CLASS_ALLOWED = ['components/Public/GuestWelcome.jsx', 'components/Public/WelcomeShell.jsx', 'components/ui/button-variants.js'];

async function sourcesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) found.push(...await sourcesUnder(path));
    else if (/\.jsx?$/.test(entry.name) && !entry.name.endsWith('.test.js')) found.push(path);
  }
  return found;
}

test('the patterned buttons appear only where design.md allows them', async () => {
  const files = await sourcesUnder(new URL('../../', import.meta.url));
  assert.ok(files.length > 50, `the sweep found ${files.length} files: the search is broken, not the code`);
  const offenders = [];
  for (const file of files) {
    const path = file.pathname.split('/src/')[1];
    const source = await readFile(file, 'utf8');
    for (const [variant, allowed] of ALLOWED) {
      if (new RegExp(`variant=["'{]+${variant}\\b`).test(source) && !allowed.includes(path)) offenders.push(`${path}: variant="${variant}"`);
    }
    if (/\bbtn-halftone\b/.test(source) && !HALFTONE_CLASS_ALLOWED.includes(path)) offenders.push(`${path}: btn-halftone`);
  }
  assert.deepEqual(offenders, [], 'a patterned button outside the landing and the onboarding');
});
