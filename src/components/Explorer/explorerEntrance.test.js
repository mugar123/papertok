import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for how an entity page opens and how the feed comes back.
 */
test('the explorer paints the name a link handed over before the entity answers', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const seedName = useMemo\(/);
  assert.match(jsx, /seedName\s*\?\s*<h1 className="ehc-name"[^>]*>\{seedName\}<\/h1>\s*:\s*<div className="ex-skel ex-skel-name"><\/div>/);
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-hero-content\.is-skeleton \{\s*animation: none;\s*\}/, 'the skeleton does not fade on top of the page transition');
  assert.match(jsx, /<div className="explorer-hero-content is-skeleton">/);
});

test('the explorer chunk is preloaded with the other screens a session reaches', async () => {
  const app = await read('../../App.jsx');
  assert.match(app, /EntityExplorer\.preload\(\)\.catch/);
});

test('coming back to the feed resumes it at rest instead of replaying the arrival', async () => {
  const transition = await read('../Layout/PageTransition.jsx');
  assert.match(transition, /data-nav-direction=\{direction\}/);
  const css = await read('../Feed/PaperCard.css');
  assert.match(css, /\[data-nav-direction="-1"\] \.pc-sheet,[\s\S]*?\[data-nav-direction="-1"\] \.pc-side-actions \{\s*animation: none;\s*\}/);
});
