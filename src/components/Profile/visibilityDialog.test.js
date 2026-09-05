import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The visibility question and the editor's controls on shadcn/Base UI.
 * The prompt is a modal Dialog; the two cards are one RadioGroup; the
 * editor's switches, fields and pin toggles are the shared primitives —
 * with the field/label/error associations they had before.
 */

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = name => readFile(new URL(name, import.meta.url), 'utf8').then(stripComments);

test('the visibility prompt is a modal Dialog that reports its outcome once, after the leave', async () => {
  const jsx = await read('./VisibilityPrompt.jsx');
  assert.match(jsx, /from '\.\.\/ui\/dialog\.jsx'/);
  assert.match(jsx, /<Dialog open=\{open\} onOpenChange=\{setOpen\} onOpenChangeComplete=\{settle\} modal>/);
  assert.doesNotMatch(jsx, /framer-motion|addEventListener|aria-modal=/);
  const settle = jsx.match(/const settle = \(isOpen\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(settle, 'VisibilityPrompt lost settle()');
  assert.match(settle[0], /if \(savedChoice\.current\) onResolved\(savedChoice\.current\);\s*else onDismiss\(\);/);
  assert.equal((jsx.match(/\bonResolved\(/g) ?? []).length, 1);
  assert.equal((jsx.match(/\bonDismiss\(\)/g) ?? []).length, 1);
  // The saved choice only closes the sheet once the write has landed.
  assert.match(jsx, /await saveProfileVisibility\(choice\);\s*savedChoice\.current = choice;\s*setOpen\(false\);/);
  assert.match(jsx, /closeLabel=\{copy\.close\}/);
  assert.match(jsx, /initialFocus=\{laterButton\}/);
});

test('the two visibility cards are one Base UI radio group styled off data-checked', async () => {
  const jsx = await read('./VisibilityChoice.jsx');
  assert.match(jsx, /from '\.\.\/ui\/radio-group\.jsx'/);
  assert.match(jsx, /<RadioGroup[\s\S]*?aria-label=\{copy\.legend\}[\s\S]*?value=\{value \?\? null\}/);
  assert.match(jsx, /<RadioGroupItem[\s\S]*?render=\{\(\s*<motion\.div\s+className="visibility-option"/);
  assert.doesNotMatch(jsx, /role="radio"|aria-checked|is-selected/);
  const css = await read('./VisibilityChoice.css');
  assert.match(css, /\.visibility-option\[data-checked\]\s*\{/);
  assert.doesNotMatch(css, /is-selected/);
});

test('the editor draws its switches, fields and pin toggles from the shared primitives', async () => {
  const jsx = await read('./ProfilePage.jsx');
  for (const name of ['Input', 'Label', 'Switch', 'Textarea', 'Toggle']) {
    assert.match(jsx, new RegExp(`import \\{ ${name} \\} from '\\.\\./ui/${name.toLowerCase()}\\.jsx'`), `ProfilePage no longer imports ${name}`);
  }
  assert.doesNotMatch(jsx, /type="checkbox"|role="switch"|aria-pressed=/, 'a hand-rolled control came back');
  assert.equal((jsx.match(/<Switch\b/g) ?? []).length, 3);
  assert.equal((jsx.match(/<Label className="profile-switch">/g) ?? []).length, 3, 'each switch is named by the label that wraps it');
  // Field associations survive the swap.
  assert.match(jsx, /<Input\s+id="profile-handle"[\s\S]*?aria-invalid=\{handleError \? 'true' : undefined\}\s*aria-describedby="profile-handle-hint"/);
  assert.match(jsx, /<Label htmlFor="profile-handle">/);
  assert.match(jsx, /<Label htmlFor="profile-name">/);
  assert.match(jsx, /<Label htmlFor="profile-bio">/);
  assert.match(jsx, /<Textarea\s+id="profile-bio"[\s\S]*?aria-describedby="profile-bio-count"/);
  // The pin toggles keep their pressed state through the Toggle primitive.
  assert.match(jsx, /<Toggle[\s\S]*?pressed=\{attributed\}/);
  assert.match(jsx, /<Toggle[\s\S]*?pressed=\{isPinned\}/);
  const css = await read('./ProfilePage.css');
  assert.doesNotMatch(css, /profile-switch-track|profile-switch-thumb|\.profile-switch input/);
});
