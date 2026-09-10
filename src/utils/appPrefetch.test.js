import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * The idle prefetch warmed eleven chunks for whoever was on the page — a guest
 * on /login included, who has none of the taps those chunks are for (the
 * avatar and the gear live in the Navbar, which only renders with a session;
 * the overlays open from cards a guest does not see). Gated on the session's
 * uid, not the user object: AuthContext calls setUser on every auth event,
 * and a fresh object would re-arm the timer for nothing.
 */
test('SOURCE: the idle prefetch waits for a session, so a guest on /login does not pay for eleven chunks', async () => {
  const code = stripComments(await read('../App.jsx'));
  assert.match(code, /const sessionUid = user\?\.uid \?\? null/, 'the gate is the uid, not the user object');
  const effect = bounded(code, 'useEffect(() => {\n    if (!sessionUid) return', '}, [sessionUid])', 'the prefetch effect', 45);
  assert.match(effect, /const prefetch = \(\) => \{/, 'the guard sits in the effect that schedules the prefetch, not somewhere else');
  assert.match(effect, /const timer = setTimeout\(\(\) => schedule\(prefetch\), 2500\)/, 'the delay is unchanged; only who it runs for');
  assert.match(effect, /return \(\) => clearTimeout\(timer\)/, 'a session that ends before the timer fires cancels it');
});
