import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * `useNavigate` reads the location, so a card calling it re-renders on every
 * navigation — ~300 ms across the mounted cards each time a topic pill was
 * tapped (2026-09-11). The card must reach the navigator without the location.
 */
test('SOURCE: the feed card does not subscribe to the location', async () => {
  const card = strip(await read('../components/Feed/PaperCard.jsx'));
  assert.doesNotMatch(card, /\buseNavigate\b|\buseLocation\b|\buseHref\b|\buseMatch\b/, 'router hooks that read the location re-render every card');
  assert.match(card, /const navigate = useStableNavigate\(\);/);
});

test('SOURCE: the stable navigator reads NavigationContext only, never the location', async () => {
  const hook = strip(await read('./useStableNavigate.js'));
  assert.match(hook, /useContext\(UNSAFE_NavigationContext\)/);
  assert.doesNotMatch(hook, /useLocation|LocationContext/);
  assert.match(hook, /\}, \[navigator\]\);/, 'one callback per navigator, which never changes');
});

test('SOURCE: every card navigation is an absolute path, since there is no location to resolve against', async () => {
  const card = strip(await read('../components/Feed/PaperCard.jsx'));
  const calls = [...card.matchAll(/navigate\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 3, `expected the three topic/author navigations, found ${calls.length}`);
  for (const arg of calls) assert.match(arg, /^path$|^-1$|^`\/|^'\//, `navigate(${arg}) must be an absolute path or a number`);
});
