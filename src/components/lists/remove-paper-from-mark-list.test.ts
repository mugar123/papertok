import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarkWriteOptions } from '../../context/write-mark.ts';
import { markChanges, markStartsOn, writeMark } from '../../context/write-mark.ts';
import { removePaperFromMarkList } from './remove-paper-from-mark-list.ts';

type Paper = { id: string };

// The three lists drawn from FeedContext's marks, with toggles that change a
// mark the way the context does: through `writeMark`, honouring the options
// they are given, against writes the test answers. `toggleLike` flips the like
// unless it is a removal (`afterWrite`), which starts from a liked paper;
// `toggleReadLater` sets the value it is given.
function markedLists() {
  const rows: Record<string, Set<string>> = {
    __read__: new Set(['p1', 'p2']),
    __favorites__: new Set(['p1', 'p2']),
    __read_later__: new Set(['p1', 'p2']),
  };
  const writes: string[] = [];
  const changes = markChanges();
  let answer!: { accept: () => void; refuse: (error: Error) => void };
  const take = (listId: string, paperId: string, value: boolean, startedFrom: boolean, options: MarkWriteOptions) => writeMark({
    show: () => {
      if (value) rows[listId].add(paperId);
      else rows[listId].delete(paperId);
    },
    undo: () => {
      if (startedFrom) rows[listId].add(paperId);
      else rows[listId].delete(paperId);
    },
    write: () => new Promise<void>((accept, refuse) => {
      writes.push(`${listId}:${paperId}=${value}`);
      answer = { accept, refuse };
    }),
    failure: 'refused',
    ...options,
    stillSignedIn: () => true,
    changes,
    markKey: `u1:${listId}:${paperId}`,
    from: startedFrom,
    to: value,
    isOn: () => rows[listId].has(paperId),
  });
  return {
    rows,
    writes,
    answer: () => answer,
    marks: {
      unmarkAsRead: (id: string, options: MarkWriteOptions) => take('__read__', id, false, true, options),
      toggleLike: (paper: Paper, options: MarkWriteOptions) => {
        const wasLiked = markStartsOn(options, rows.__favorites__.has(paper.id));
        return take('__favorites__', paper.id, !wasLiked, wasLiked, options);
      },
      toggleReadLater: (paper: Paper, value: boolean, options: MarkWriteOptions) => take('__read_later__', paper.id, value, !value, options),
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

  test(`${listId}: a removal asked for again after the first was accepted sends nothing and puts nothing back`, async () => {
    const { rows, writes, answer, marks } = markedLists();
    const removal = removePaperFromMarkList(listId, 'p2', { id: 'p2' }, { ...marks, onFailed: () => assert.fail('accepted') });
    answer().accept();
    await removal;
    // A phone sheet opened while the first removal was pending still offers Remove.
    const again = removePaperFromMarkList(listId, 'p2', { id: 'p2' }, { ...marks, onFailed: () => assert.fail('nothing to refuse') });
    assert.deepEqual(writes, [`${listId}:p2=false`], 'one write, taking the mark off');
    await again;
    assert.deepEqual([...rows[listId]], ['p1'], 'the paper stays out of the list');
  });

  test(`${listId}: a row whose stored copy carries another id takes off the row's own mark`, async () => {
    const { rows, writes, answer, marks } = markedLists();
    const removal = removePaperFromMarkList(listId, 'p2', { id: 'arxiv-p2' }, { ...marks, onFailed: () => assert.fail('accepted') });
    assert.deepEqual(writes, [`${listId}:p2=false`]);
    answer().accept();
    await removal;
    assert.deepEqual([...rows[listId]], ['p1']);
  });
}

test('a custom list is left to its own removal', () => {
  const { marks } = markedLists();
  assert.equal(removePaperFromMarkList('list-1', 'p2', { id: 'p2' }, { ...marks, onFailed: () => {} }), null);
});
