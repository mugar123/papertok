import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE tests for finding C3 of docs/AUDITORIA-COMENTARIOS-2026-09-05.md:
 * the sheet opened with an empty footer while the viewer's profile was on
 * the wire, and a stalled channel ended as "create your profile".
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the composer gate is the pure module, seeded from the account caches', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /from '\.\/composerGate\.js'/);
  assert.match(jsx, /composerStateFor\(\{ isAuthenticated, ownProfile \}\)/);
  assert.match(jsx, /seedOwnProfile\(auth\.currentUser\?\.uid\)/);
  assert.doesNotMatch(jsx, /viewerProfileCache/, 'the private one-slot cache is gone');
});

test('the own profile is read with patience and a stalled read never becomes "no profile"', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const effect = jsx.match(/patientRead\(\(\) => readOwnUserProfile\(\)[\s\S]*?controller\.abort\(\);/);
  assert.ok(effect, 'the profile read goes through patientRead and aborts on cleanup');
  assert.match(effect[0], /onLateResult: apply/);
  assert.match(effect[0], /if \(isReadTimeout\(error\)\) return;/);
  // `apply` is declared above the patientRead call, so it is outside the
  // match above; pin it on the whole file.
  assert.match(jsx, /rememberOwnProfile\(uid, profile\)/, 'the answer is written through to the shared cache');
});

test('the footer has a branch for loading: the composer, disabled', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const loading = jsx.match(/composerState === 'loading' && \([\s\S]*?\n\s*\)\}/);
  assert.ok(loading, 'a loading branch exists in the footer');
  assert.match(loading[0], /<Textarea[\s\S]*?className="comments-composer-input"[\s\S]*?disabled/);
  assert.match(loading[0], /placeholder=\{text\(COPY\.loading\)\}/);
  assert.match(loading[0], /aria-busy="true"/);
  assert.doesNotMatch(loading[0], /onClose\(\)/, 'the drawer test allows exactly one onClose() in the file');
  // The accessibility test matches the FIRST <Textarea> in the file and
  // expects the live composer; the placeholder one must come after it.
  const ready = jsx.indexOf("composerState === 'ready' && (");
  assert.ok(ready > -1 && ready < jsx.indexOf("composerState === 'loading' && ("), 'the loading branch sits after the ready branch');
});

test('the composer field carries exactly one aria-label', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const textarea = jsx.match(/<Textarea\b[\s\S]*?\/>/);
  assert.ok(textarea, 'the composer Textarea changed shape; update this test alongside it');
  const labels = textarea[0].match(/aria-label=/g) || [];
  assert.equal(labels.length, 1,
    'the shadcn migration left two aria-label attributes on the composer: the placeholder '
    + 'one and the real label. JSX keeps the last, so the name is right by accident — '
    + 'the dead one goes.');
  assert.match(textarea[0], /aria-label=\{text\(COPY\.composerLabel\)\}/);
});
