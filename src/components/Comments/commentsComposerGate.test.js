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

test('the own profile is read with authority and patience, and a stall is never a verdict', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /readConfirmedOwnUserProfile/);
  assert.doesNotMatch(
    jsx,
    /readOwnUserProfile\b/,
    'the plain read RESOLVES a cache-served miss as null — nothing above it can retry a '
    + 'success — and the footer then tells an account that has a public profile to create one.',
  );
  const effect = jsx.match(/patientRead\(\(\) => readConfirmedOwnUserProfile\(\)[\s\S]*?controller\.abort\(\);/);
  assert.ok(effect, 'the profile read goes through patientRead and aborts on cleanup');
  assert.match(effect[0], /attempts: 3/, 'the same patience as the thread, which is what the comment above it claims');
  assert.match(effect[0], /onSlow:/);
  assert.match(effect[0], /onLateResult: apply/);
  assert.match(effect[0], /if \(isReadTimeout\(error\)\) \{/);
});

test('only a confirmed answer reaches the profile cache the other screens read', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.equal((jsx.match(/rememberOwnProfile\(/g) || []).length, 1,
    'one write-through, and it is the one below');
  const apply = jsx.match(/const apply = \(profile\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(apply, 'the profile effect still applies through one function');
  assert.match(apply[0], /rememberOwnProfile\(uid, profile\)/,
    'the write-through lives on the confirmed path and nowhere else: ownProfileCache is SHARED, '
    + 'and /settings/profile seeds its "create your profile" screen from it.');
  const failure = jsx.match(/console\.error\('The viewer profile could not be read'[\s\S]*?\n {6}\}\)/);
  assert.ok(failure, 'the non-transient failure branch is still there');
  assert.doesNotMatch(failure[0], /rememberOwnProfile/, 'a denial is local news, not a cached fact');
});

test('the footer has a branch for loading: the composer, inert but not gone', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const loading = jsx.match(/composerState === 'loading' && \([\s\S]*?<\/footer>/);
  assert.ok(loading, 'a loading branch closes the footer');
  const field = loading[0].match(/<Textarea[\s\S]*?\/>/);
  assert.ok(field, 'the inert composer is still a Textarea of the same shape');
  assert.match(field[0], /className="comments-composer-input"/);
  assert.match(field[0], /placeholder=\{text\(COPY\.loading\)\}/);
  assert.match(field[0], /aria-label=\{text\(COPY\.composerLabel\)\}/);
  assert.match(loading[0], /aria-busy="true"/);
  assert.doesNotMatch(loading[0], /onClose\(\)/, 'the drawer test allows exactly one onClose() in the file');
  // The accessibility test anchors on ref={composerInput}, but the gate test
  // below still matches the first <Textarea>; the live one comes first.
  const ready = jsx.indexOf("composerState === 'ready' && (");
  assert.ok(ready > -1 && ready < jsx.indexOf("composerState === 'loading' && ("), 'the loading branch sits after the ready branch');
});

test('the inert composer keeps its place in the tab order, and says why it is inert', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /composerWaking: \{\s*es: '[^']+',\s*en: '[^']+',?\s*\}/, 'the wait has bilingual copy');
  assert.match(
    jsx,
    /const PROFILE_WAIT_COPY = \{[\s\S]*?slow: COPY\.composerWaking,[\s\S]*?offline: COPY\.noConnection,[\s\S]*?stalled: COPY\.stalledLoad,[\s\S]*?\};/,
    'the three waits of the profile read each have a sentence, the stalled one included',
  );

  const loading = jsx.match(/composerState === 'loading' && \([\s\S]*?<\/footer>/)[0];
  const field = loading.match(/<Textarea[\s\S]*?\/>/)[0];
  // `aria-disabled` is wanted; a bare `disabled` is not. The lookbehind is
  // what keeps the two apart.
  assert.doesNotMatch(
    field,
    /(?<![-\w])disabled\b/,
    'a disabled control is out of the tab order, so the one element that has something to '
    + 'say about the dead composer could not be reached by anyone tabbing the sheet.',
  );
  assert.match(field, /readOnly/, 'inert, but focusable');
  assert.match(field, /aria-disabled="true"/);
  assert.match(field, /aria-describedby=\{profileWait \? profileWaitId : undefined\}/);

  assert.match(loading, /\{profileWait && \(/);
  assert.match(loading, /<ThreadSlot key="composer-wait" reduced=\{prefersReducedMotion\}>/,
    'the sheet already owns this motion; the wait borrows it rather than inventing a curve');
  assert.match(loading, /id=\{profileWaitId\} className="comments-composer-wait" role="status"/);
  assert.match(loading, /text\(PROFILE_WAIT_COPY\[profileWait\]\)/);
  assert.doesNotMatch(loading, /COPY\.retry/, 'retry belongs to the body, which already owns it');
});

test('the profile read reports its wait, and its terminal state is not silence', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const effect = jsx.match(/patientRead\(\(\) => readConfirmedOwnUserProfile\(\)[\s\S]*?controller\.abort\(\);/)[0];
  assert.match(effect, /const waited = slowNoticeStatus\(Date\.now\(\) - startedAt, info\);/,
    'an unconfirmed absence rejects in under a millisecond, so the words wait for a real wait');
  assert.match(effect, /setProfileWait\(waited\)/);
  assert.match(effect, /if \(isReadTimeout\(error\)\) \{\s*\n[\s\S]*?setProfileWait\('stalled'\);/,
    'a spent budget used to be a silent return, leaving "Cargando..." forever with no words');
  assert.match(effect, /setProfileWait\(null\)/, 'an answer clears the wait');
});

test('the wait for the profile has its own quiet chrome, from the tokens', async () => {
  const css = await readFile(new URL('./CommentsSheet.css', import.meta.url), 'utf8');
  const rule = css.match(/\.comments-composer-wait \{[^}]*\}/)?.[0] || '';
  assert.match(rule, /border: 1px solid var\(--tint-neutral-line\);/);
  assert.match(rule, /background: var\(--tint-neutral-bg\);/);
  assert.match(rule, /color: var\(--tint-neutral-fg\);/);
  // `readOnly` does not reach the primitive's :disabled styling, so the box
  // has to look inert on its own.
  assert.match(css, /\.comments-composer-input\[aria-disabled='true'\] \{[^}]*\}/);
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
