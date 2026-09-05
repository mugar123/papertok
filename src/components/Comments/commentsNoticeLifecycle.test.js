import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE tests for C1 of docs/AUDITORIA-COMENTARIOS-2026-09-05.md: the
 * "Comment posted." chip stayed forever, in neutral grey, with no motion.
 * The live region stays mounted (a region born with its message is often
 * not announced); what moves is a keyed chip inside it.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the notice is the pure lifecycle, and a success expires on a timer armed for its sequence', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /from '\.\/noticeLifecycle\.js'/);
  assert.match(jsx, /useState\(IDLE_NOTICE\)/);
  const effect = jsx.match(/const lifetime = noticeLifetime\(notice\);[\s\S]*?\}, \[notice\]\);/);
  assert.ok(effect, 'an effect keyed on the notice arms its lifetime');
  assert.match(effect[0], /setTimeout\(\(\) => setNotice\(previous => expireNotice\(previous, seq\)\), lifetime\)/);
  assert.match(effect[0], /return \(\) => clearTimeout\(timer\);/);
  assert.doesNotMatch(jsx, /setNotice\(\{/, 'every call site goes through announce()/clearNotice()');
});

test('both live regions stay mounted, and neither ever changes role', async () => {
  const jsx = await read('./CommentsSheet.jsx');

  // A region whose role or politeness changes is re-registered by several
  // screen readers, and the mutation that changed it is the one they drop —
  // the same hazard as a node born with its message, which is why the
  // wrapper is permanent in the first place. `clearedNotice` keeps the tone,
  // so a success leaving and a failure arriving used to flip status → alert
  // in the very frame the alert text landed.
  assert.doesNotMatch(jsx, /role=\{notice\.tone/, 'the role is fixed per region, never computed');
  assert.doesNotMatch(jsx, /aria-live=\{notice\.tone/, 'and so is the politeness');

  const polite = jsx.match(/<div className="comments-sheet-notice" role="status" aria-live="polite">[\s\S]*?<\/div>/);
  assert.ok(polite, 'the polite region is mounted permanently');
  assert.match(polite[0], /<AnimatePresence mode="wait" initial=\{false\}>/);
  assert.match(polite[0], /\{notice\.text && notice\.tone !== 'error' && \(\s*<ThreadSlot key=\{notice\.seq\} reduced=\{prefersReducedMotion\}>/);
  assert.match(polite[0], /className=\{`comments-sheet-notice-chip is-\$\{notice\.tone\}`\}/);

  const alert = jsx.match(/<div className="comments-sheet-notice" role="alert" aria-live="assertive">[\s\S]*?<\/div>/);
  assert.ok(alert, 'the assertive region is mounted permanently too');
  assert.match(alert[0], /<AnimatePresence mode="wait" initial=\{false\}>/);
  assert.match(alert[0], /\{notice\.text && notice\.tone === 'error' && \(\s*<ThreadSlot key=\{notice\.seq\} reduced=\{prefersReducedMotion\}>/);
  assert.match(alert[0], /className="comments-sheet-notice-chip is-error"/);

  // Both sit between the body and the footer, and the wrapper has no chrome
  // of its own, so the empty one costs nothing.
  assert.match(jsx, /<\/div>\s*\n\s*<\/div>\s*\n\s*<footer/);
  assert.doesNotMatch(jsx, /has-text/);
});

test('success is green, error is red, the rest neutral — all from tokens', async () => {
  const css = await readFile(new URL('./CommentsSheet.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /has-text/);
  assert.doesNotMatch(css, /\.comments-sheet-notice \{[^}]*line-height: 0/);
  const base = css.match(/\.comments-sheet-notice-chip \{[^}]*\}/)?.[0] || '';
  assert.match(base, /background: var\(--tint-neutral-bg\);/);
  assert.match(base, /margin: var\(--space-3\) 0 var\(--space-4\);/);
  const success = css.match(/\.comments-sheet-notice-chip\.is-success \{[^}]*\}/)?.[0] || '';
  assert.match(success, /border-color: var\(--tint-green-line\);/);
  assert.match(success, /background: var\(--tint-green-bg\);/);
  assert.match(success, /color: var\(--tint-green-fg\);/);
  const error = css.match(/\.comments-sheet-notice-chip\.is-error \{[^}]*\}/)?.[0] || '';
  assert.match(error, /background: var\(--tint-red-bg\);/);
  assert.match(error, /color: var\(--tint-red-fg\);/);
});
