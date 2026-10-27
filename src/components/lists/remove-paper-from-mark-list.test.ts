import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarkWriteOptions } from '../../context/write-mark.ts';
import { writeMark } from '../../context/write-mark.ts';
import { removePaperFromMarkList } from './remove-paper-from-mark-list.ts';

type Paper = { id: string };

// The three lists drawn from FeedContext's marks, with toggles that change a
// mark the way the context does: through `writeMark`, honouring the options
// they are given, against a write the test answers.
function markedLists() {
  const rows: Record<string, Set<string>> = {
    __read__: new Set(['p1', 'p2']),
    __favorites__: new Set(['p1', 'p2']),
    __read_later__: new Set(['p1', 'p2']),
  };
  let answer!: { accept: () => void; refuse: (error: Error) => void };
  const take = (listId: string, paperId: string, options: MarkWriteOptions) => writeMark({
    show: () => { rows[listId].delete(paperId); },
    undo: () => { rows[listId].add(paperId); },
    write: () => new Promise<void>((accept, refuse) => { answer = { accept, refuse }; }),
    failure: 'refused',
    ...options,
    stillSignedIn: () => true,
  });
  return {
    rows,
    answer: () => answer,
    marks: {
      unmarkAsRead: (id: string, options: MarkWriteOptions) => take('__read__', id, options),
      toggleLike: (paper: Paper, options: MarkWriteOptions) => take('__favorites__', paper.id, options),
      toggleReadLater: (paper: Paper, value: boolean, options: MarkWriteOptions) => take('__read_later__', paper.id, options),
    },
  };
}

const silenced = async (run: () => Promise<unknown>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

for (const listId of ['__read__', '__favorites__', '__read_later__']) {
  test(`${listId}: a refused removal never moves the row, and says so`, async () => {
    const { rows, answer, marks } = markedLists();
    const failures: unknown[] = [];
    const removal = removePaperFromMarkList(listId, 'p2', { id: 'p2' }, { ...marks, onFailed: (error) => failures.push(error) });
    assert.ok(removal);
    assert.ok(rows[listId].has('p2'), 'the row stays while the write is in flight');
    const refused = new Error('permission-denied');
    answer().refuse(refused);
    await silenced(() => removal);
    assert.ok(rows[listId].has('p2'), 'and after the refusal');
    assert.deepEqual(failures, [refused]);
  });

  test(`${listId}: an accepted removal takes the row out`, async () => {
    const { rows, answer, marks } = markedLists();
    const removal = removePaperFromMarkList(listId, 'p2', { id: 'p2' }, { ...marks, onFailed: () => assert.fail('accepted') });
    answer().accept();
    await removal;
    assert.deepEqual([...rows[listId]], ['p1']);
  });
}

test('a custom list is left to its own removal', () => {
  const { marks } = markedLists();
  assert.equal(removePaperFromMarkList('list-1', 'p2', { id: 'p2' }, { ...marks, onFailed: () => {} }), null);
});
