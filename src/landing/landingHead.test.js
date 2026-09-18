import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/* The gate is RUN, not read. Its whole job is to decide a destination out of
   three inputs, and a regex over its text cannot tell `'/feed' + search +
   hash` from `'/feed' + hash + search` — one of which is a URL and the other
   of which is not. `new Function` gives it exactly the `window` it touches. */
const runGate = ({ hash = '', search = '', mark = null, storageThrows = false } = {}) => {
  let replaced = null;
  const fakeWindow = {
    location: { hash, search, replace: (url) => { replaced = url; } },
    localStorage: {
      getItem: (key) => {
        if (storageThrows) throw new Error('storage is disabled');
        return key === 'papertok_signed_in' ? mark : null;
      },
    },
  };
  new Function('window', scripts[0])(fakeWindow);
  return replaced;
};

test('the session gate is the first script in the head, before any stylesheet', () => {
  assert.match(scripts[0], /localStorage\.getItem\('papertok_signed_in'\) === '1'/);
  assert.equal(runGate({ mark: '1' }), '/feed');
  assert.equal(runGate({ mark: null }), null, 'a visitor with no mark stays on the landing');
  assert.equal(runGate({ mark: '0' }), null, 'only the exact mark counts');
  assert.ok(html.indexOf('<script>') < html.indexOf('<link rel="stylesheet"'));
});
test('a deep link keeps its hash on the way to the app', () => {
  assert.equal(runGate({ hash: '#/public/paper/abc' }), '/feed#/public/paper/abc');
  // A hash that is not a route is not a route: `#main-content` is this page's
  // own skip target, and sending it to the app would break the skip link.
  assert.equal(runGate({ hash: '#main-content' }), null);
});
test('the query string travels with both redirects, in front of the fragment', () => {
  // The dev and preview twin (feedToApp in vite.config.js) carries it, and
  // every `?probe=` cache-buster in scripts/diagnostics depends on it.
  assert.equal(runGate({ hash: '#/lists', search: '?probe=7' }), '/feed?probe=7#/lists');
  assert.equal(runGate({ mark: '1', search: '?utm_source=x' }), '/feed?utm_source=x');
});
test('a browser that refuses storage sees the landing instead of an error', () => {
  assert.equal(runGate({ storageThrows: true }), null);
  // ...but a deep link is honoured before storage is ever touched, so it
  // still works in that browser.
  assert.equal(runGate({ hash: '#/lists', storageThrows: true }), '/feed#/lists');
});
test('the theme and motion gates are still there after the session gate', () => {
  assert.match(scripts[1], /papertok_theme/);
  assert.match(scripts[2], /data-motion/);
});
test('the motion gate is withdrawn if motion.js never reports for duty', () => {
  // The gate hides the map's nodes and the highlight bands before first paint
  // and only motion.js shows them again. A module that 404s after a deploy
  // would leave that permanent, and silently: an empty plate, no underlines.
  assert.match(scripts[2], /addEventListener\('load'/);
  assert.match(scripts[2], /hasAttribute\('data-motion-ready'\)/);
  assert.match(scripts[2], /removeAttribute\('data-motion'\)/);

  const motion = readFileSync(fileURLToPath(new URL('./motion.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // The receipt is written at the END of init, after the arming: an init that
  // throws half way must not leave a receipt saying it finished.
  const init = motion.slice(motion.indexOf('export function init()'));
  const receipt = init.indexOf("setAttribute('data-motion-ready'");
  const armed = init.indexOf('armReveals()');
  assert.ok(receipt > 0, 'init never writes the receipt the head script waits for');
  assert.ok(receipt > armed, 'the receipt is written before the page is armed');
  // And the other half: declining withdraws the gate rather than walking away
  // from a page it has left hidden.
  assert.match(init, /removeAttribute\('data-motion'\)/);
});
test('AuthContext writes the mark on sign-in and clears it on sign-out', () => {
  const ctx = readFileSync(fileURLToPath(new URL('../context/AuthContext.jsx', import.meta.url)), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(ctx, /import \{ markSignedIn, clearSignedIn \} from '\.\.\/utils\/sessionMark\.js'/);
  assert.match(ctx, /currentUser \? markSignedIn\(\) : clearSignedIn\(\)/);
});
