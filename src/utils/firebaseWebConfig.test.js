import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FIREBASE = new URL('../services/firebase.js', import.meta.url);
const VERCEL = new URL('../../vercel.json', import.meta.url);
const ENV_EXAMPLE = new URL('../../.env.example', import.meta.url);
const DEVELOPMENT = new URL('../../docs/DEVELOPMENT.md', import.meta.url);

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
 * SOURCE tests. The Firebase web config is a literal in the code, on purpose:
 * every value ships in the bundle anyway, and `authDomain` is our own host
 * because Vercel proxies /__/auth/* to Firebase's sign-in handler — the domain
 * and the rewrite have to change together, in one commit. For months the env
 * example and the development guide still advertised six VITE_FIREBASE_*
 * variables that nothing read. These pin both sides: the code keeps not
 * reading them, and the docs keep not promising them.
 */
test('SOURCE: the Firebase web config is a literal that agrees with the auth rewrite in vercel.json', async () => {
  const code = stripComments(await readFile(FIREBASE, 'utf8'));
  const config = bounded(code, 'const firebaseConfig = {', '};', 'the config literal', 24);
  const projectId = config.match(/projectId: "([^"]+)"/)?.[1];
  assert.ok(projectId, 'projectId is a string literal in the config');
  assert.match(config, /authDomain: "papertok\.app"/, 'sign-in is served from our own domain');
  assert.doesNotMatch(code, /import\.meta\.env\.VITE_FIREBASE/,
    'nothing reads VITE_FIREBASE_*; if that ever changes, the block goes back into .env.example and DEVELOPMENT.md');

  const vercel = JSON.parse(await readFile(VERCEL, 'utf8'));
  const auth = vercel.rewrites.find(rule => rule.source === '/__/auth/:path*');
  assert.ok(auth, 'the auth handler rewrite is gone from vercel.json');
  assert.equal(auth.destination, `https://${projectId}.firebaseapp.com/__/auth/:path*`,
    'the rewrite must point at the same Firebase project the code initialises');
});

test('the env example and the development guide say where the config lives instead of listing variables nothing reads', async () => {
  const env = await readFile(ENV_EXAMPLE, 'utf8');
  assert.doesNotMatch(env, /^VITE_FIREBASE_/m, '.env.example still lists VITE_FIREBASE_* variables');
  assert.match(env, /src\/services\/firebase\.js/, '.env.example says where the Firebase config lives');
  assert.match(env, /vercel\.json/, '.env.example says why authDomain is code and not config');

  const guide = await readFile(DEVELOPMENT, 'utf8');
  assert.doesNotMatch(guide, /`VITE_FIREBASE_\*`/, 'DEVELOPMENT.md still has the VITE_FIREBASE_* row');
  assert.match(guide, /src\/services\/firebase\.js/, 'DEVELOPMENT.md says where the Firebase config lives');
  assert.match(guide, /\/__\/auth\/\*/, 'DEVELOPMENT.md ties authDomain to the Vercel rewrite');
});
