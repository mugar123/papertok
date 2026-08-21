import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  commitTagInput,
  diffListSelection,
  hasUnsavedChanges,
  removeTag,
} from './saveOrganizeModel.js';

/* --- The two-direction diff ------------------------------------------------
   The paper can already live in lists when the modal opens. Save must add to
   the newly checked ones AND remove from the unchecked ones — an add-only
   save silently keeps the paper wherever it was. */

test('save diff adds newly checked lists and removes unchecked ones', () => {
  const { toAdd, toRemove } = diffListSelection(['a', 'b'], ['b', 'c']);
  assert.deepEqual(toAdd, ['c']);
  assert.deepEqual(toRemove, ['a']);
});

test('an untouched selection produces an empty diff', () => {
  const { toAdd, toRemove } = diffListSelection(['a', 'b'], ['b', 'a']);
  assert.deepEqual(toAdd, []);
  assert.deepEqual(toRemove, []);
});

test('unchecking everything removes everything', () => {
  const { toAdd, toRemove } = diffListSelection(['a', 'b'], []);
  assert.deepEqual(toAdd, []);
  assert.deepEqual(toRemove, ['a', 'b']);
});

/* --- Tags as chips --------------------------------------------------------- */

test('Enter commits the input as a trimmed chip', () => {
  assert.deepEqual(commitTagInput(['thesis'], '  review '), ['thesis', 'review']);
});

test('a pasted comma list becomes several chips', () => {
  assert.deepEqual(commitTagInput([], 'a, b ,, c'), ['a', 'b', 'c']);
});

test('committing a duplicate or empty input changes nothing', () => {
  assert.deepEqual(commitTagInput(['a'], 'a'), ['a']);
  assert.deepEqual(commitTagInput(['a'], '   '), ['a']);
});

test('a chip can be removed', () => {
  assert.deepEqual(removeTag(['a', 'b', 'c'], 'b'), ['a', 'c']);
});

/* --- The close guard's question -------------------------------------------- */

const CLEAN = {
  listIds: ['a'], note: 'n', tags: ['t1', 't2'], readLater: false,
};

test('an untouched modal has nothing to lose', () => {
  assert.equal(hasUnsavedChanges({ initial: CLEAN, pending: { ...CLEAN, listIds: ['a'] } }), false);
});

test('checking a list, unchecking one, editing the note, the tags or Read later each count as unsaved changes', () => {
  assert.equal(hasUnsavedChanges({ initial: CLEAN, pending: { ...CLEAN, listIds: ['a', 'b'] } }), true);
  assert.equal(hasUnsavedChanges({ initial: CLEAN, pending: { ...CLEAN, listIds: [] } }), true);
  assert.equal(hasUnsavedChanges({ initial: CLEAN, pending: { ...CLEAN, note: 'edited' } }), true);
  assert.equal(hasUnsavedChanges({ initial: CLEAN, pending: { ...CLEAN, tags: ['t1'] } }), true);
  assert.equal(hasUnsavedChanges({ initial: CLEAN, pending: { ...CLEAN, readLater: true } }), true);
});

test('tags with spaces cannot fake equality across boundaries', () => {
  assert.equal(hasUnsavedChanges({
    initial: { ...CLEAN, tags: ['a b', 'c'] },
    pending: { ...CLEAN, tags: ['a', 'b c'] },
  }), true);
});

/* --- SOURCE: nothing writes outside the save path ---------------------------
   "Closing without saving writes nothing" and "toggling writes nothing" are
   claims about where the write primitives live. The component keeps its two
   write sites LAST (handleCreateList — the explicit Create button, which
   creates an empty list — and then handleSave); everything before them
   (selection toggles, tag editing, the close guard) must be write-free. The
   assertions below pin that ordering, so a write sneaking into a toggle
   handler moves an index and fails here. */

test('SOURCE: firestore writes live only in handleCreateList and handleSave', async () => {
  const source = await readFile(new URL('../components/Lists/SaveToListModal.jsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export default'));
  const createAt = body.indexOf('const handleCreateList');
  const saveAt = body.indexOf('const handleSave');
  assert.ok(createAt > 0 && saveAt > createAt, 'expected handleCreateList, then handleSave');

  const indexesOf = (needle) => {
    const found = [];
    let at = body.indexOf(needle);
    while (at !== -1) {
      found.push(at);
      at = body.indexOf(needle, at + 1);
    }
    return found;
  };

  for (const primitive of ['updateDoc(', 'arrayUnion(', 'arrayRemove(']) {
    const indexes = indexesOf(primitive);
    assert.ok(indexes.length > 0, `${primitive} expected in the save path`);
    for (const at of indexes) {
      assert.ok(at > saveAt, `${primitive} found before handleSave — a write outside the save path`);
    }
  }
  for (const at of indexesOf('setDoc(')) {
    assert.ok(at > createAt, 'setDoc found before handleCreateList — a write outside the two write sites');
  }
});

test('SOURCE: the dialog cancel path goes through the unsaved-changes guard', async () => {
  const source = await readFile(new URL('../components/Lists/SaveToListModal.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('onCancel'), 'the <dialog> Escape path must be intercepted');
  assert.ok(source.includes('requestClose'), 'every close path funnels through requestClose');
});
