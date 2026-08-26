import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  commitTagInput,
  diffListSelection,
  hasUnsavedChanges,
  resolveSelection,
  toggleListIntent,
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

/* --- The selection is an INTENT over the membership, not a frozen snapshot ---
   The modal paints from a session cache that can be up to thirty seconds
   stale, and revalidates behind it. The old model kept the whole pending set
   as state and stopped updating it the moment the user touched one checkbox,
   so a membership that arrived AFTER that first touch became `initial` while
   `pending` stayed frozen on the stale snapshot — and every list the fresh
   read knew about but the stale one did not turned into a REMOVAL the user
   never asked for.

   The fix is to store only what the user actually did (checked / unchecked)
   and derive the selection from whatever membership is current. */

const NO_INTENT = { checked: [], unchecked: [] };

test('THE BUG: a list the fresh read reveals is not silently unchecked by an unrelated toggle', () => {
  // The cache said the paper was only in A. The user unticks A. Then the
  // revalidation lands: the paper is in A *and* B — B was added on a phone.
  const intent = toggleListIntent(NO_INTENT, 'a', ['a']);
  const selection = resolveSelection({ membership: ['a', 'b'], ...intent });

  assert.deepEqual([...selection], ['b'], 'B was never touched; it must stay selected');
  const { toAdd, toRemove } = diffListSelection(['a', 'b'], selection);
  assert.deepEqual(toRemove, ['a'], 'only the list the user actually unticked is removed');
  assert.deepEqual(toAdd, []);
});

test('an untouched selection follows the membership wherever it lands', () => {
  assert.deepEqual([...resolveSelection({ membership: ['a'], ...NO_INTENT })], ['a']);
  assert.deepEqual([...resolveSelection({ membership: ['a', 'b'], ...NO_INTENT })], ['a', 'b']);
  assert.deepEqual([...resolveSelection({ membership: [], ...NO_INTENT })], []);
});

test('what the user checked survives a membership that does not mention it', () => {
  const intent = toggleListIntent(NO_INTENT, 'new', ['a']);
  assert.deepEqual([...resolveSelection({ membership: ['a'], ...intent })], ['a', 'new']);
});

test('toggling the same row twice leaves no intent behind', () => {
  let intent = toggleListIntent(NO_INTENT, 'a', ['a']);
  assert.deepEqual(intent.unchecked, ['a']);
  intent = toggleListIntent(intent, 'a', ['a']);
  assert.deepEqual(intent.checked, [], 'checking back on clears the removal');
  assert.deepEqual(intent.unchecked, [], 'and does not leave a redundant addition');
  assert.deepEqual([...resolveSelection({ membership: ['a'], ...intent })], ['a']);
});

test('an intent about a list that no longer exists cannot resurrect it', () => {
  const intent = toggleListIntent(NO_INTENT, 'gone', []);
  const selection = resolveSelection({ membership: ['a'], ...intent, known: ['a'] });
  assert.deepEqual([...selection], ['a'], 'a deleted list must not be written to');
});

test('a membership that arrives is never gated by the lists on screen', () => {
  // `known` bounds what the user's own ticks can reach, never the server truth:
  // a membership filtered by a half-painted screen would become a removal.
  const selection = resolveSelection({ membership: ['a', 'b'], ...NO_INTENT, known: [] });
  assert.deepEqual([...selection], ['a', 'b']);
});
