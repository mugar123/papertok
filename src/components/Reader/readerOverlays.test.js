import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The reader's overlays are shadcn/ui on Base UI now, and the primitive owns
 * what used to be hand-rolled: the focus trap, Escape, restoring focus, the
 * leave being played before the node goes. These hold the shape of that
 * migration against the source, the way `readerMobileStyles.test.js` holds
 * the stylesheet: a `useDialogFocus` that quietly came back, a framer
 * `AnimatePresence` re-wrapped around the shell, or a `ToggleGroup` fed a
 * string instead of the array Base UI expects would all still lint and build.
 */

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the reader shell is a modal Base UI Dialog that owns its own leave', async () => {
  const jsx = stripComments(await read('./PaperReader.jsx'));

  assert.match(jsx, /import \{ Dialog, DialogContent \} from '\.\.\/ui\/dialog\.jsx';/);
  // Modal (FeedContainer's scroll guard reads the `aria-modal` Base UI sets)
  // and never dismissed by a pointer: a full-screen surface has no outside.
  // The root's props, up to its content child: the arrow functions in them
  // carry a `>` of their own, so the tag cannot be read as `[^>]*`.
  const root = jsx.match(/<Dialog\s([\s\S]*?)>\s*<DialogContent/);
  assert.ok(root, 'expected a <Dialog> root wrapping <DialogContent>');
  assert.match(root[1], /\bmodal\b/);
  assert.match(root[1], /\bdisablePointerDismissal\b/);
  // The card is told once, and only once the leave has played.
  assert.match(jsx, /onOpenChangeComplete=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/);
  // The way back keeps focus on open, as `data-dialog-initial-focus` used to.
  assert.match(jsx, /initialFocus=\{closeButtonRef\}/);
  assert.match(jsx, /<DialogContent[\s\S]*?aria-label=\{copy\.title\}/);

  // What the primitive replaced must not come back beside it.
  assert.doesNotMatch(jsx, /useDialogFocus/);
  assert.doesNotMatch(jsx, /aria-modal=/);
  assert.doesNotMatch(jsx, /<AnimatePresence onExitComplete/);
  assert.doesNotMatch(jsx, /data-dialog-initial-focus/);
});

test('the reader\'s toggle groups speak Base UI\'s array API', async () => {
  const reader = stripComments(await read('./PaperReader.jsx'));
  const rail = stripComments(await read('./AnnotationRail.jsx'));

  // `value` is always an array and `onValueChange` receives the whole array;
  // a `type="single"` / string value is the Radix shape and silently breaks.
  assert.match(reader, /<ToggleGroup\s[\s\S]*?value=\{\[level\]\}[\s\S]*?onValueChange=\{\(\[next\]\) =>/);
  assert.match(rail, /<ToggleGroup\s[\s\S]*?value=\{\[filter\]\}[\s\S]*?onValueChange=\{\(\[next\]\) =>/);
  assert.doesNotMatch(reader, /type="single"/);
  assert.doesNotMatch(rail, /type="single"/);
});

test('the selection menu and the export card are anchored popovers', async () => {
  const menu = stripComments(await read('./SelectionMenu.jsx'));
  const card = stripComments(await read('./ExportCard.jsx'));
  const reader = stripComments(await read('./PaperReader.jsx'));

  // The menu sits on the selection's own rectangle — Base UI positions it,
  // flips it and keeps it on the page; nothing measures by hand any more.
  assert.match(menu, /<PopoverPrimitive\.Positioner[\s\S]*?anchor=\{resolveAnchor\}/);
  assert.match(menu, /onOpenChange=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/);
  assert.match(menu, /aria-label=\{copy\.selectionTitle\}/);
  assert.doesNotMatch(menu, /placeSelectionMenu|position:\s*'fixed'|role="dialog"/);

  // The card is the content half of a Popover whose trigger is the download
  // button, so it is anchored above it wherever that slot renders.
  assert.match(card, /<PopoverContent[\s\S]*?aria-label=\{copy\.download\}/);
  assert.doesNotMatch(card, /role="dialog"|onClose/);
  assert.match(reader, /<Popover open=\{exportOpen\}[\s\S]*?<PopoverTrigger[\s\S]*?<ExportCard/);
});

test('the reader stylesheets draw the arrival on Base UI\'s own attributes', async () => {
  const reader = stripComments(await read('./PaperReader.css'));
  const annotations = stripComments(await read('./Annotations.css'));

  assert.match(reader, /\.rd\[data-open\]\s*\{[^}]*animation:\s*rdShellIn/);
  assert.match(reader, /\.rd\[data-closed\]\s*\{[^}]*animation:\s*rdShellOut/);
  // Reduced motion still arrives and leaves, by opacity alone.
  const still = reader.slice(reader.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(still, /\.rd\[data-open\]\s*\{[^}]*animation:\s*rdRevealStill/);

  // The popup takes focus when a keyboard opens it; the global ring is the
  // indicator, so the menu must not switch it off.
  const menuRule = annotations.match(/\.rd-menu\s*\{([^}]*)\}/);
  assert.ok(menuRule, 'expected a .rd-menu rule');
  assert.doesNotMatch(menuRule[1], /outline\s*:\s*(?:none|0)/);
  assert.match(annotations, /\.rd-menu\[data-starting-style\]/);
  // The filter chips are pressed in Base UI's vocabulary, not the old `data-on`.
  assert.match(annotations, /\.rd-rail-filter\[data-pressed\]/);
  assert.doesNotMatch(annotations, /\.rd-rail-filter\[data-on\]/);
});
