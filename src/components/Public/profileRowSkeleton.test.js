import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * A waiting row used to borrow the lists grid's 132 px tile — a tall blank
 * block under a heading that promised rows. The placeholder now has the
 * finished row's silhouette: a rule down the left, a kicker line, a title
 * line or two, a meta line, so nothing jumps when the title lands.
 */
test('a waiting row is shaped like a row, not like a list tile', async () => {
  const jsx = await read('./PublicProfilePage.jsx');
  const waiting = jsx.slice(jsx.indexOf('if (row.unresolved)'), jsx.indexOf('const title = cleanPaperText(row.title)'));
  assert.ok(waiting.length > 0, 'expected to have found the unresolved branch');
  assert.match(waiting, /<RowSkeleton/, 'the waiting row renders the row silhouette');
  assert.doesNotMatch(waiting, /public-profile-skeleton--row/, 'and no longer the list tile');
});

test('the Saved and Liked panels wait with row silhouettes too', async () => {
  const jsx = await read('./PublicProfilePage.jsx');
  const saved = jsx.slice(jsx.indexOf("activeTab === 'saved' &&"), jsx.indexOf("activeTab === 'liked' &&"));
  const liked = jsx.slice(jsx.indexOf("activeTab === 'liked' &&"), jsx.indexOf('</motion.section>'));
  assert.match(saved, /loadingRowList/);
  assert.match(liked, /loadingRowList/);
  assert.doesNotMatch(saved, /\bloadingRows\b/);
  assert.doesNotMatch(liked, /\bloadingRows\b/);
});

test('the row silhouette has a kicker, a title and a meta line, and respects reduced motion', async () => {
  const css = await read('./PublicProfilePage.css');
  for (const part of ['kicker', 'title', 'meta']) {
    assert.match(css, new RegExp(`\\.profile-row-skeleton-line--${part}\\s*\\{`), `missing the ${part} line`);
  }
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.match(reduced, /profile-row-skeleton-line/, 'the shimmer must stop under reduced motion');
});
