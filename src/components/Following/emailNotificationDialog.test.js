import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The email-updates modal on shadcn/Base UI: a Dialog controlled by the
 * settings page, and a Switch and a Select each named by a Label. There is no
 * frequency to choose: the digest is weekly for everyone.
 */

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = name => readFile(new URL(name, import.meta.url), 'utf8').then(stripComments);

test('the email modal is a modal Dialog whose only way out is the parent\'s onClose', async () => {
  const jsx = await read('./EmailNotificationModal.tsx');
  assert.match(jsx, /from '\.\.\/ui\/dialog\.jsx'/);
  assert.match(jsx, /<Dialog open=\{isOpen\} onOpenChange=\{nextOpen => \{ if \(!nextOpen\) onClose\(\); \}\} modal>/);
  assert.match(jsx, /closeLabel=(?:"Close"|\{'Close'\})/);
  assert.doesNotMatch(jsx, /closeOnEscape|addEventListener|role="dialog"|aria-modal=|useReducedMotion/);
  // framer stays only for the content it animates: the feedback line and
  // the test button's three states.
  assert.match(jsx, /<AnimatePresence mode="wait" initial=\{false\}>/);
});

test('the controls are the shared Switch and Select, each with its name', async () => {
  const jsx = await read('./EmailNotificationModal.tsx');
  assert.doesNotMatch(jsx, /type="checkbox"|<select|<option/);
  assert.match(jsx, /<Label htmlFor=\{enabledId\}>/);
  assert.match(jsx, /<Switch\s+id=\{enabledId\}[\s\S]*?onCheckedChange=\{checked => setDraft\(current => \(\{ \.\.\.current, enabled: checked \}\)\)\}/);
  assert.match(jsx, /<Label htmlFor=\{countId\}>/);
  assert.match(jsx, /<Select\s+items=\{MAX_PAPERS_OPTIONS\}\s+value=\{draft\.maxPapers \|\| 5\}\s+onValueChange=\{value => setDraft\(current => \(\{ \.\.\.current, maxPapers: Number\(value\) \}\)\)\}/);
  assert.match(jsx, /<SelectTrigger id=\{countId\}/);
  const css = await read('./EmailNotificationModal.css');
  assert.doesNotMatch(css, /button\.is-active|email-notification-switch::after|input:checked|email-notification-close/);
});
