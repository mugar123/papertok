import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Settings on shadcn/Base UI: the account-deletion confirmation is an
 * AlertDialog, the interests editor is (at last) a real Dialog, and the
 * page's switch and its two choices are the shared Switch and RadioGroup.
 */

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (name: string|URL) => readFile(new URL(name, import.meta.url), 'utf8').then(stripComments);

test('deleting an account is confirmed in an AlertDialog that nothing dismisses while it works', async () => {
  const jsx = await read('./DeleteAccountDialog.tsx');
  assert.match(jsx, /from '\.\.\/ui\/alert-dialog\.tsx'/);
  assert.match(jsx, /<AlertDialog\s+open=\{open\}\s+onOpenChange=\{handleOpenChange\}\s+onOpenChangeComplete=\{\(isOpen\) => \{ if \(!isOpen\) onClose\(\); \}\}/);
  assert.doesNotMatch(jsx, /useDialogFocus|role="dialog"|aria-modal=/);
  assert.match(jsx, /const handleOpenChange = \(nextOpen: boolean\) => \{\s*if \(working\) return;\s*setOpen\(nextOpen\);/);
  assert.equal((jsx.match(/\bonClose\(\)/g) ?? []).length, 1, 'onClose reaches the parent from exactly one place');
  // The phrase field: shared Input under its Label, focused on arrival,
  // its error still associated.
  assert.match(jsx, /<Label htmlFor=\{inputId\}>/);
  assert.match(jsx, /<Input\s+ref=\{inputRef\}\s+id=\{inputId\}[\s\S]*?aria-invalid=\{error \? 'true' : undefined\}\s*aria-describedby=\{error \? errorId : undefined\}/);
  assert.match(jsx, /initialFocus=\{inputRef\}/);
  assert.match(jsx, /aria-label=\{copy\.close\}/);
  assert.match(jsx, /role="status"\s+aria-live="polite"/);
});

test('deleting an account signs the person in again from the click, before anything is deleted', async () => {
  // Browsers block a popup that is not opened by the user's gesture, so the
  // sign-in has to be the handler's first await and has to come before the
  // deletion service.
  const jsx = await read('./DeleteAccountDialog.tsx');
  const handler = jsx.match(/const handleDelete = async \(\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? '';
  const awaited = [...handler.matchAll(/await (\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(awaited.slice(0, 2), ['reauthenticateCurrentUser', 'deleteAccount']);
  // The account deleted is the one that signed in again, not whoever holds the
  // session when the window closes.
  const confirmedUid = handler.match(/const (\w+) = await reauthenticateCurrentUser\(\)/)?.[1];
  assert.ok(confirmedUid, 'the sign-in result is kept');
  assert.match(handler, new RegExp(`await deleteAccount\\(${confirmedUid}\\)`));
});

test('the interests editor is a modal Dialog with a named close and pressed chips', async () => {
  const jsx = await read('./EditInterestsModal.tsx');
  assert.match(jsx, /from '\.\.\/ui\/dialog\.tsx'/);
  assert.match(jsx, /<Dialog open=\{isOpen\} onOpenChange=\{nextOpen => \{ if \(!nextOpen\) onClose\(\); \}\} modal>/);
  assert.match(jsx, /closeLabel=\{'Close'\}/);
  assert.doesNotMatch(jsx, /isClosing|setIsClosing|setTimeout\(\(\) => \{\s*onClose/, 'the exit timer is the primitive\'s now');
  // The chips are the shared Toggle: a native button on which Base UI
  // writes `aria-pressed` and `data-pressed`, so the pill's CSS reads the
  // attribute and no class mirrors the state by hand any more.
  assert.match(jsx, /import \{ Toggle \} from '\.\.\/ui\/toggle\.tsx'/);
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
  const jsx = await read('./SettingsPage.tsx');
  assert.match(jsx, /import \{ Switch \} from '\.\.\/ui\/switch\.tsx'/);
  assert.match(jsx, /import \{ RadioGroup, RadioGroupItem \} from '\.\.\/ui\/radio-group\.tsx'/);
  assert.match(jsx, /import \{ Button \} from '\.\.\/ui\/button\.tsx'/);
  assert.doesNotMatch(jsx, /role="switch"|role="radiogroup"|role="radio"|aria-checked/);
  assert.match(jsx, /<Switch\s+className="settings-toggle"[\s\S]*?aria-label=\{copy\.analyticsToggleLabel\}/);
  assert.match(jsx, /<RadioGroup\s+className="settings-levels"\s+aria-label=\{copy\.aiLevelLabel\}[\s\S]*?onValueChange=\{handleLevelChange\}/);
  // The interface language choice is gone: the app is English-only.
  assert.doesNotMatch(jsx, /settings-language|handleLanguageChange|setLanguage/);
  // Each choice is a real button, so the page's own card rules still apply.
  assert.equal((jsx.match(/render=\{<button type="button" \/>\}\s+nativeButton/g) ?? []).length, 1);
  const css = await read('./SettingsPage.css');
  assert.match(css, /\.settings-levels button\[data-checked\][^{,]*\{/);
  assert.doesNotMatch(css, /\.settings-levels button\.is-active|\.settings-language button\.is-active|\.settings-toggle\.is-active|\.settings-toggle > span/);
});

test('each settings page is its own route, so the rail is links rather than a scroll spy', async () => {
  const jsx = await read('./SettingsPage.tsx');
  assert.match(jsx, /<NavLink\s+key=\{entry\.slug\}\s+to=\{`\/settings\/\$\{entry\.slug\}`\}\s+replace/);
  assert.doesNotMatch(jsx, /useSectionSpy/);
  assert.deepEqual(jsx.match(/[\w?.()'-]+\.scrollIntoView\(/g), ["indexListRef.current?.querySelector('a.is-active')?.scrollIntoView("]);
});

test('the settings pages carry their own field and switch styles, with no public-profile editor behind them', async () => {
  const jsx = await read('./SettingsPage.tsx');
  // Nothing here reads or writes the public profile, and nothing imports the
  // deleted Profile components or their stylesheets.
  assert.doesNotMatch(jsx, /from '\.\.\/Profile\/|userProfileService|savePublicProfilePhoto/);
  const css = await read('./SettingsPage.css');
  const rendered = new Set((jsx.match(/className="[^"]*"/g) ?? [])
    .flatMap((attribute: string) => attribute.slice('className="'.length, -1).split(/\s+/))
    .filter((name: string) => name.startsWith('profile-')));
  assert.ok(rendered.has('profile-switch'), 'expected to find the analytics switch class');
  for (const name of rendered) {
    assert.match(css, new RegExp(`\\.${name}\\s*[{,]`), `.${name} is rendered but SettingsPage.css has no rule for it`);
  }
  // The panel that holds them is drawn with the settings line, defined here
  // for both themes and stronger on ink.
  assert.match(css, /\.settings-page\s*\{[^}]*--settings-panel-line:\s*var\(--border-subtle\)/);
  const dark = css.match(/:root\[data-theme='dark'\] \.settings-page\s*\{[^}]*\}/);
  assert.ok(dark, 'SettingsPage.css has no dark-theme block for .settings-page');
  assert.match(dark[0], /--settings-panel-line:\s*var\(--border-strong\)/);
  assert.match(css, /\.profile-fields\s*\{[^}]*border:\s*1px solid var\(--settings-panel-line\)/);
});
