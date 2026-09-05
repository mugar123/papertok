import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Settings on shadcn/Base UI: the account-deletion confirmation is an
 * AlertDialog, the interests editor is (at last) a real Dialog, and the
 * page's switch and its two choices are the shared Switch and RadioGroup.
 */

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = name => readFile(new URL(name, import.meta.url), 'utf8').then(stripComments);

test('deleting an account is confirmed in an AlertDialog that nothing dismisses while it works', async () => {
  const jsx = await read('./DeleteAccountDialog.jsx');
  assert.match(jsx, /from '\.\.\/ui\/alert-dialog\.jsx'/);
  assert.match(jsx, /<AlertDialog\s+open=\{open\}\s+onOpenChange=\{handleOpenChange\}\s+onOpenChangeComplete=\{\(isOpen\) => \{ if \(!isOpen\) onClose\(\); \}\}/);
  assert.doesNotMatch(jsx, /useDialogFocus|role="dialog"|aria-modal=/);
  assert.match(jsx, /const handleOpenChange = \(nextOpen\) => \{\s*if \(working\) return;\s*setOpen\(nextOpen\);/);
  assert.equal((jsx.match(/\bonClose\(\)/g) ?? []).length, 1, 'onClose reaches the parent from exactly one place');
  // The phrase field: shared Input under its Label, focused on arrival,
  // its error still associated.
  assert.match(jsx, /<Label htmlFor=\{inputId\}>/);
  assert.match(jsx, /<Input\s+ref=\{inputRef\}\s+id=\{inputId\}[\s\S]*?aria-invalid=\{error \? 'true' : undefined\}\s*aria-describedby=\{error \? errorId : undefined\}/);
  assert.match(jsx, /initialFocus=\{inputRef\}/);
  assert.match(jsx, /aria-label=\{copy\.close\}/);
  assert.match(jsx, /role="status"\s+aria-live="polite"/);
});

test('the interests editor is a modal Dialog with a named close and pressed chips', async () => {
  const jsx = await read('./EditInterestsModal.jsx');
  assert.match(jsx, /from '\.\.\/ui\/dialog\.jsx'/);
  assert.match(jsx, /<Dialog open=\{isOpen\} onOpenChange=\{nextOpen => \{ if \(!nextOpen\) onClose\(\); \}\} modal>/);
  assert.match(jsx, /closeLabel=\{isEnglish \? 'Close' : 'Cerrar'\}/);
  assert.doesNotMatch(jsx, /isClosing|setIsClosing|setTimeout\(\(\) => \{\s*onClose/, 'the exit timer is the primitive\'s now');
  // The chips are the shared Toggle: a native button on which Base UI
  // writes `aria-pressed` and `data-pressed`, so the pill's CSS reads the
  // attribute and no class mirrors the state by hand any more.
  assert.match(jsx, /import \{ Toggle \} from '\.\.\/ui\/toggle\.jsx'/);
  assert.match(jsx, /<Toggle\s[\s\S]*?className="eim-pill"\s+pressed=\{isSelected\}\s+onPressedChange=\{\(\) => toggleSubcategory\(subKey\)\}/);
  assert.doesNotMatch(jsx, /aria-pressed=|eim-pill--selected/);
  // "Select all" per area is an action, not a state: it stays a plain button.
  assert.match(jsx, /<button\s+type="button"\s+className="eim-area-toggle-btn"/);
  const css = await read('./EditInterestsModal.css');
  assert.doesNotMatch(css, /eim-overlay--closing|eim-fade-in|eim-slide-up|eim-close-btn/);
  assert.match(css, /\.eim-pill\[data-pressed\]\s*\{/);
  assert.doesNotMatch(css, /eim-pill--selected/);
});

test('the settings page uses the shared Switch and RadioGroup, and styles them off data-checked', async () => {
  const jsx = await read('./SettingsPage.jsx');
  assert.match(jsx, /import \{ Switch \} from '\.\.\/ui\/switch\.jsx'/);
  assert.match(jsx, /import \{ RadioGroup, RadioGroupItem \} from '\.\.\/ui\/radio-group\.jsx'/);
  assert.match(jsx, /import \{ Button \} from '\.\.\/ui\/button\.jsx'/);
  assert.doesNotMatch(jsx, /role="switch"|role="radiogroup"|role="radio"|aria-checked/);
  assert.match(jsx, /<Switch\s+className="settings-toggle"[\s\S]*?aria-label=\{copy\.analyticsToggleLabel\}/);
  assert.match(jsx, /<RadioGroup\s+className="settings-levels"\s+aria-label=\{copy\.aiLevelLabel\}[\s\S]*?onValueChange=\{handleLevelChange\}/);
  assert.match(jsx, /<RadioGroup\s+className="settings-language"\s+aria-label=\{copy\.languageLabel\}[\s\S]*?onValueChange=\{handleLanguageChange\}/);
  // Each choice is a real button, so the page's own card rules still apply.
  assert.equal((jsx.match(/render=\{<button type="button" \/>\}\s+nativeButton/g) ?? []).length, 3);
  const css = await read('./SettingsPage.css');
  assert.match(css, /\.settings-levels button\[data-checked\]\s*\{/);
  assert.match(css, /\.settings-language button\[data-checked\]\s*\{/);
  assert.doesNotMatch(css, /\.settings-levels button\.is-active|\.settings-language button\.is-active|\.settings-toggle\.is-active|\.settings-toggle > span/);
});
