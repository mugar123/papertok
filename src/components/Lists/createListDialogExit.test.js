import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE test for the window's identity while it leaves.
 *
 * The caller owns `open` and clears the list in the same turn --
 * `onClose={() => setEditing(null)}` -- but Base UI holds the popup in the
 * document until `createListOut` has played. Reading the `list` prop straight
 * through therefore made the window change its mind on the way out: the
 * title, the colour hint, the submit button and the privacy note all key off
 * `editing`, so the editor turned into the "new list" window for the length
 * of its own exit.
 *
 * Measured 2026-09-07 over CDP, closing the editor for a list named
 * "Neurociencia": at the first frame after the click the card already read
 * `Nueva lista` / `Cancelar | Crear` and had grown from 417px to 487px, then
 * faded out at that new size over 160ms. What reads as a second window
 * appearing under the first one is this one window, still on screen, having
 * become the other.
 *
 * The window holds the list it was opened with until it is gone. `open` is
 * the prop, not a latch, so nothing here is undone by the caller mounting the
 * component for good: `openedWith` only ever takes a value while the window
 * is open.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the window keeps the list it was opened with until its exit has played', async () => {
  const jsx = await read('./CreateListDialog.jsx');

  assert.match(jsx, /const \[openedWith, setOpenedWith\] = useState\(list\);/, 'the list it was opened with is not held anywhere');
  // Written while rendering, not from an effect: an effect runs after the
  // paint, so the window would show one frame of the wrong list on the way
  // in. React re-renders before painting when a component sets its own state
  // during render, which is what makes the hold invisible.
  assert.match(
    jsx,
    /if \(open && openedWith !== list\) setOpenedWith\(list\);/,
    'the hold has to be taken while the window is open, and only then',
  );
  assert.match(jsx, /const activeList = open \? list : openedWith;/);
});

test('every field that tells the two windows apart reads the held list, never the prop', async () => {
  const jsx = await read('./CreateListDialog.jsx');

  assert.match(jsx, /const editing = Boolean\(activeList\);/);
  assert.match(jsx, /const \{ id: listId, name: listName, emoji: listIcon \} = activeList \?\? \{\};/);
  assert.match(jsx, /const listColor = editing \? resolveListColorId\(activeList\) : null;/);

  // The exact expression the bug was written in. A single one of these left
  // behind is the whole regression back.
  assert.doesNotMatch(jsx, /Boolean\(list\)/, 'the window would flip to "new list" the moment the caller clears it');
  assert.doesNotMatch(jsx, /resolveListColorId\(list\)/);
  assert.doesNotMatch(jsx, /\} = list \?\? \{\};/);
});

test('the title, the note and the submit button still hang off `editing`, so holding it holds all four', async () => {
  const jsx = await read('./CreateListDialog.jsx');

  assert.match(jsx, /\{editing \? copy\.editTitle : copy\.title\}/);
  assert.match(jsx, /\{editing \? copy\.colorHintEdit : copy\.colorHint\}/);
  assert.match(jsx, /\{!editing && <p className="create-list-note">\{copy\.privacyNote\}<\/p>\}/);
});
