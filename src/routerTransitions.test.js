import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE test: the router is mounted in main.jsx, which node cannot run.
 *
 * React Router 7 wraps every navigation's state update in
 * `React.startTransition`. A transition renders in the background, sliced and
 * at low priority, and the per-frame work of the feed starves it: measured on
 * the tab bar (headless Chromium, mobile emulation, CPU ×4), a tap on
 * Following changed nothing on screen for 699 ms with the chunk warm — no
 * underline, no exit — because both read `useLocation()`. Synchronous, the
 * exit started 11 ms after the tap. The prop is what keeps it synchronous.
 */
test('SOURCE: the router updates its location synchronously, so a tab tap is acknowledged on the next frame', async () => {
  const code = stripComments(await read('./main.jsx'));
  assert.match(code, /<HashRouter useTransitions=\{false\}>/, 'navigation must not be a React transition');
  assert.doesNotMatch(code, /<HashRouter>/, 'a bare <HashRouter> falls back to transitions');
});
