import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Paper } from '../models/Paper.ts';
import type { OwnList } from '../utils/ownLists.ts';

/**
 * The Save button's operations, run with React state and Firestore injected
 * the way feedLateTopicSave.test.ts runs the feed context's callbacks.
 *
 * Reproduced 2026-10-21 against the Firestore emulator behind a 120 ms proxy:
 * eight taps 300 ms apart left the button unchanged for the first second,
 * then changed it six times, the last 1.7 s after the last tap, and it ended
 * the opposite of what the last tap asked. The button only changed once
 * Firestore had confirmed every write, so each tap meanwhile started the
 * same operation again from the state it still saw.
 */
const source = readFileSync(new URL('./useQuickSave.ts', import.meta.url), 'utf8');
function callback(name: string) {
  const open = `const ${name} = useCallback(`;
  const from = source.indexOf(open);
  const to = source.indexOf('\n  }, [', from);
  assert.ok(from >= 0 && to > from, `${name} must exist`);
  return stripTypeScriptTypes(source.slice(from + open.length, to) + '\n  }');
}
const compile = (code: string, scope: object) => new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Toast { kind: 'plain' | 'success' | 'error'; text: string; action?: { label: string; onClick: () => void } }
type ToastOptions = { action?: Toast['action'] };

/**
 * Firestore as the client sees it: every write and read stays pending until
 * the test answers it, so a tap can land while the previous one is in flight.
 * The feed context's marks update the same Set and library the handler reads,
 * as the real context re-renders the hook with.
 */
function harness({ saved = false, readLater = false } = {}) {
  const paper = { id: '2401.00001', title: 'A paper', authors: ['A. Author'], published: '2026-01-01' } as Paper;
  const savedPaperIds = new Set<string>(saved ? [paper.id] : []);
  const personalLibrary: Record<string, { readLater?: boolean }> = readLater ? { [paper.id]: { readLater: true } } : {};
  const calls: string[] = [];
  const pending = { setDoc: [] as Deferred<void>[], readLists: [] as Deferred<OwnList[] | null>[], membership: [] as Deferred<void>[] };
  const toasts: Toast[] = [];
  const toast = Object.assign(
    (text: string, options?: ToastOptions) => { toasts.push({ kind: 'plain', text, action: options?.action }); },
    {
      success: (text: string, options?: ToastOptions) => { toasts.push({ kind: 'success', text, action: options?.action }); },
      error: (text: string) => { toasts.push({ kind: 'error', text }); },
    },
  );
  const markSaved = async (p: Paper) => { calls.push('markSaved'); savedPaperIds.add(p.id); };
  const unmarkSaved = async (p: Paper) => { calls.push('unmarkSaved'); savedPaperIds.delete(p.id); };
  const toggleReadLater = async (p: Paper) => {
    calls.push('toggleReadLater');
    const next = !personalLibrary[p.id]?.readLater;
    personalLibrary[p.id] = { readLater: next };
    return next;
  };
  const setDoc = () => { calls.push('setDoc'); const d = deferred<void>(); pending.setDoc.push(d); return d.promise; };
  const readListsHoldingPaper = () => { calls.push('readLists'); const d = deferred<OwnList[] | null>(); pending.readLists.push(d); return d.promise; };
  const writeListMembership = ({ lists, added }: { lists: OwnList[]; added: boolean }) => {
    calls.push(`membership:${added ? 'add' : 'remove'}:${lists.length}`);
    if (lists.length === 0) return Promise.resolve();
    const d = deferred<void>();
    pending.membership.push(d);
    return d.promise;
  };
  const scope: Record<string, unknown> = {
    interactionIdFor: (p: Paper) => p.id,
    user: { uid: 'reader' },
    IS_DEMO: false,
    language: 'en',
    setDoc,
    savedPaperDocRef: (uid: string, id: string) => `users/${uid}/savedPapers/${id}`,
    buildSavedPaperPayload: (p: Paper) => ({ title: p.title }),
    writeListMembership,
    readListsHoldingPaper,
    toast,
    markActivation: () => { calls.push('markActivation'); },
    onSaveToList: () => { calls.push('openPicker'); },
    savedPaperIds,
    personalLibrary,
    toggleReadLater,
    markSaved,
    unmarkSaved,
    inFlight: { current: new Set<string>() },
    saveState: { current: { savedPaperIds, personalLibrary, toggleReadLater, markSaved, unmarkSaved } },
    oneAtATime: null,
    restoreSave: null,
  };
  scope.oneAtATime = compile(callback('oneAtATime'), scope);
  scope.restoreSave = compile(callback('restoreSave'), scope);
  const press: (p: Paper) => Promise<void> = compile(callback('handleSaveToList'), scope);
  const count = (name: string) => calls.filter(call => call === name).length;
  return { paper, press, calls, count, pending, toasts, savedPaperIds, personalLibrary };
}

test('a tap fills the button at once; the writes follow and the toast confirms them', async () => {
  const h = harness();
  const op = h.press(h.paper);
  assert.deepEqual(h.calls, ['setDoc', 'markSaved'], 'the saved document is issued and the mark lands before Firestore answers');
  assert.ok(h.savedPaperIds.has(h.paper.id));
  assert.equal(h.toasts.length, 0, 'nothing is confirmed yet');
  h.pending.setDoc[0].resolve();
  await op;
  assert.deepEqual(h.calls, ['setDoc', 'markSaved', 'membership:add:0', 'toggleReadLater', 'markActivation']);
  assert.equal(h.personalLibrary[h.paper.id]?.readLater, true);
  assert.deepEqual(h.toasts.map(t => [t.kind, t.text, t.action?.label]), [['success', 'Saved to Read later', 'Add to list']]);
});

test('taps while the paper\'s operation runs do nothing, and the next tap after it runs the other way', async () => {
  const h = harness();
  const first = h.press(h.paper);
  // Not awaited: a dropped tap settles at once, and a tap that was not
  // dropped would wait on a write nobody answers.
  void h.press(h.paper);
  void h.press(h.paper);
  assert.equal(h.count('markSaved'), 1);
  assert.equal(h.count('setDoc'), 1, 'no second chain of writes');
  h.pending.setDoc[0].resolve();
  await first;
  assert.equal(h.toasts.length, 1, 'one toast per operation, not per tap');

  const unsave = h.press(h.paper);
  assert.deepEqual(h.calls.slice(-2), ['unmarkSaved', 'readLists'], 'the button empties at the tap, before the lists are read');
  assert.ok(!h.savedPaperIds.has(h.paper.id));
  void h.press(h.paper);
  assert.equal(h.count('readLists'), 1, 'a tap during the read is dropped');
  h.pending.readLists[0].resolve([]);
  await unsave;
  assert.deepEqual(h.calls.slice(-2), ['membership:remove:0', 'toggleReadLater'], 'Read later follows once the lists are known');
  assert.equal(h.personalLibrary[h.paper.id]?.readLater, false);
  assert.deepEqual(h.toasts.at(-1)?.text, 'Removed from your saved papers');
  assert.equal(h.toasts.at(-1)?.action?.label, 'Undo');
});

test('a refused save puts the button back, says so and frees the paper', async () => {
  const h = harness();
  const op = h.press(h.paper);
  h.pending.setDoc[0].reject(new Error('permission-denied'));
  await op;
  assert.deepEqual(h.calls, ['setDoc', 'markSaved', 'unmarkSaved']);
  assert.ok(!h.savedPaperIds.has(h.paper.id));
  assert.deepEqual(h.toasts.map(t => [t.kind, t.text]), [['error', 'Could not save this paper']]);
  const retry = h.press(h.paper);
  assert.equal(h.count('setDoc'), 2, 'the paper is free for the next tap');
  h.pending.setDoc[1].resolve();
  await retry;
  assert.ok(h.savedPaperIds.has(h.paper.id));
});

test('a refused removal puts the button back and leaves Read later as it was', async () => {
  const h = harness({ saved: true, readLater: true });
  const op = h.press(h.paper);
  assert.ok(!h.savedPaperIds.has(h.paper.id), 'the button empties at the tap');
  h.pending.readLists[0].resolve([{ id: 'list-1', name: 'Reading', paperIds: [h.paper.id] } as OwnList]);
  await tick();
  assert.equal(h.calls.at(-1), 'membership:remove:1');
  h.pending.membership[0].reject(new Error('unavailable'));
  await op;
  assert.ok(h.savedPaperIds.has(h.paper.id), 'back to saved');
  assert.equal(h.personalLibrary[h.paper.id]?.readLater, true, 'nothing was taken from Read later');
  assert.deepEqual(h.toasts.map(t => [t.kind, t.text]), [['error', 'Could not remove this paper']]);
});

test('a full page of lists opens the picker and keeps the paper saved', async () => {
  const h = harness({ saved: true });
  const op = h.press(h.paper);
  h.pending.readLists[0].resolve(null);
  await op;
  assert.deepEqual(h.calls.slice(-2), ['markSaved', 'openPicker']);
  assert.ok(h.savedPaperIds.has(h.paper.id));
  assert.equal(h.toasts.length, 0);
});

test('Undo fills the button at once and waits its turn like a tap', async () => {
  const h = harness({ saved: true });
  const op = h.press(h.paper);
  h.pending.readLists[0].resolve([]);
  await op;
  const undo = h.toasts.at(-1)?.action;
  assert.equal(undo?.label, 'Undo');
  undo!.onClick();
  assert.ok(h.savedPaperIds.has(h.paper.id), 'saved again before Firestore answers');
  undo!.onClick();
  assert.equal(h.count('setDoc'), 1, 'a second Undo while the first runs is dropped');
  h.pending.setDoc[0].resolve();
  await tick();
  await tick();
  assert.deepEqual(h.calls.slice(-3), ['setDoc', 'markSaved', 'membership:add:0']);
});

test('a refused Undo on a paper saved again by hand leaves that save alone', async () => {
  const h = harness({ saved: true });
  const op = h.press(h.paper);
  h.pending.readLists[0].resolve([]);
  await op;
  const undo = h.toasts.at(-1)!.action!;
  const saveAgain = h.press(h.paper);
  h.pending.setDoc[0].resolve();
  await saveAgain;
  assert.ok(h.savedPaperIds.has(h.paper.id), 'saved again by a tap');
  undo.onClick();
  h.pending.setDoc[1].reject(new Error('unavailable'));
  await tick();
  await tick();
  assert.ok(h.savedPaperIds.has(h.paper.id), 'the refused Undo did not take the tap\'s save back');
  assert.deepEqual(h.toasts.at(-1)?.text, 'Could not save this paper');
});
