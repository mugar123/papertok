import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Convention of ce139ce: comments are prose, and prose must never satisfy a
// structural assertion.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* Every avatar these two screens paint comes from a document another account
   wrote. `cleanPhoto` is the allowlist the WRITER goes through; a document
   written before it existed, or by any path that skipped it, still reaches an
   <img src> here — and an arbitrary host in that src logs the IP of everyone
   who opens the page. */

const SCREENS = ['PublicProfilePage.jsx', 'FollowSheet.jsx'];

test('both avatar <img> read through cleanPhoto', async () => {
  for (const file of SCREENS) {
    const src = stripComments(await readFile(new URL(`./${file}`, import.meta.url), 'utf8'));
    assert.match(src, /cleanPhoto\(/, file);
    assert.match(src, /import \{[\s\S]*?cleanPhoto[\s\S]*?\} from '\.\.\/\.\.\/services\/userProfileService/, file);
  }
});

test('neither screen feeds a raw stored photo into an <img src>', async () => {
  for (const file of SCREENS) {
    const src = stripComments(await readFile(new URL(`./${file}`, import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /src=\{\s*profile[.?]/, `${file}: the stored value must be sanitised first`);
    assert.doesNotMatch(src, /src=\{\s*profile\?\.photo/, file);
  }
});
