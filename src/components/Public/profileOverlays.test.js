import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The profile's two rows of tabs and its follow sheet are shadcn/ui on Base
 * UI: the sheet is a Drawer (scrim, slide, swipe, focus trap, Escape, focus
 * restore all the primitive's), and both rows of tabs are `ui/tabs`, whose
 * indicator slides the yellow rule between tabs and whose list gives arrow
 * keys. These hold the seams, the way `publicProfileStyles.test.js` holds
 * the class inventory: a hand-rolled `role="tablist"` or a framer `layoutId`
 * indicator that came back, or a follow button that stopped being a Toggle,
 * would all still lint and build.
 */

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the follow sheet is a modal Drawer with line Tabs, told once after the leave', async () => {
  const jsx = stripComments(await read('./FollowSheet.jsx'));

  assert.match(jsx, /import \{ Drawer, DrawerContent \} from '\.\.\/ui\/drawer\.jsx';/);
  assert.match(jsx, /import \{ Tabs, TabsContent, TabsList, TabsTrigger \} from '\.\.\/ui\/tabs\.jsx';/);
  assert.match(jsx, /<Drawer\s[\s\S]*?\bmodal\b/);
  assert.match(jsx, /onOpenChangeComplete=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/);
  assert.equal((jsx.match(/\bonClose\(\)/g) || []).length, 1, 'onClose() should be called from exactly one place');
  // Named in the active language, and opening on the way back out.
  assert.match(jsx, /<DrawerContent[\s\S]*?aria-label=\{mode === 'followers' \? copy\.followers : copy\.following\}/);
  assert.match(jsx, /initialFocus=\{closeButton\}/);
  assert.match(jsx, /<Tabs\s[\s\S]*?value=\{mode\}[\s\S]*?onValueChange=\{\(next\) => onModeChange\(next\)\}/);
  assert.match(jsx, /<TabsList variant="line" className="follow-sheet-tabs">/);
  assert.match(jsx, /<TabsTrigger key=\{name\} value=\{name\} className="follow-sheet-tab">/);
  assert.match(jsx, /<TabsContent value=\{mode\} className="follow-sheet-panel">/);

  assert.doesNotMatch(jsx, /useDialogFocus|asChild|role="tablist"|role="tab"|aria-selected|layoutId|follow-sheet-backdrop|follow-sheet-tab--active/);
});

test('the follow sheet stylesheet styles Base UI\'s states, not the old classes', async () => {
  const css = stripComments(await read('./FollowSheet.css'));

  assert.match(css, /\.follow-sheet-tab\[data-active\]\s*\{/);
  assert.match(css, /\.follow-sheet-tabs \[data-slot='tabs-indicator'\]\s*\{/);
  assert.match(css, /\.follow-sheet-frame\s*\{/);
  assert.match(css, /\.follow-sheet-viewport\s*\{/);
  assert.match(css, /\.follow-sheet\[data-starting-style\]/);
  assert.match(css, /\.follow-sheet\[data-ending-style\]/);
  assert.doesNotMatch(css, /follow-sheet-backdrop|follow-sheet-tab--active|follow-sheet-tab-indicator/);
});

test('the owner\'s profile sections are ui Tabs and the follow button a Toggle', async () => {
  const jsx = stripComments(await read('./PublicProfilePage.jsx'));
  const css = stripComments(await read('./PublicProfilePage.css'));

  assert.match(jsx, /<Tabs\s[\s\S]*?value=\{activeTab\}[\s\S]*?onValueChange=\{\(next\) => setRequestedTab\(next\)\}/);
  assert.match(jsx, /<TabsList variant="line" className="profile-tabs" aria-label=\{copy\.tabsLabel\}>/);
  assert.match(jsx, /<TabsTrigger[\s\S]*?value=\{tab\}[\s\S]*?id=\{`profile-tab-\$\{tab\}`\}[\s\S]*?className="profile-tab"/);
  assert.match(jsx, /<TabsContent[\s\S]*?value=\{activeTab\}[\s\S]*?className="profile-panel"/);
  assert.doesNotMatch(jsx, /role="tablist"|role="tab"|role="tabpanel"|aria-selected|layoutId="profile-tab-indicator"|is-active/);

  // Following is an on/off state: `aria-pressed` through the primitive.
  assert.match(jsx, /<Toggle\s[\s\S]*?pressed=\{following\}/);
  assert.doesNotMatch(jsx, /aria-pressed=/);

  assert.match(css, /\.profile-tab\[data-active\]\s*\{/);
  assert.match(css, /\.profile-tabs \[data-slot='tabs-indicator'\]\s*\{/);
  assert.doesNotMatch(css, /\.profile-tab\.is-active|\.profile-tab-indicator/);
});
