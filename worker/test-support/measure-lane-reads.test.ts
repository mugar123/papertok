import assert from 'node:assert/strict';
import test from 'node:test';

import { measureLaneReads } from './measure-lane-reads.ts';

test('the measurement pages a seeded local D1 through readFeedPage: rows by statement, vectors only with likes, the next page from the kept order', async () => {
  // Every leaf and area lane holds 40 papers and every notable lane 3 of each
  // of its ten years: under each lane's share, so each read returns the lane.
  const rows = await measureLaneReads(
    { leafRows: 40, areaRows: 40, notablePerYear: 3 },
    { readers: [['cs.LG'], ['cs.LG', 'cs.RO']], likes: 4, excluded: 10, seen: 30, repetitions: 1 },
  );
  const returned = rows.map(row => [row.categories, row.likes, row.page, row.after, row.returned.lanes, row.returned.notable, row.returned.vectors, row.papers]);
  assert.deepEqual(returned, [
    // cs.LG and area:ai; notable:cs.LG. With likes: the 4 likes' vectors, then
    // the 66 candidates neither liked nor excluded and the 30 notable ones. The
    // next page reads none of it from its kept order, but ranks again, as a first
    // page does, 16 minutes later (RANKING_KEPT_MS) or after a dismissal, which is
    // a negative: its vector is read even without likes. A lean that moved to
    // `relevance` changes `rankedBy` too.
    [1, 0, 0, '', 80, 30, 0, 20],
    [1, 0, 1, '', 0, 0, 0, 20],
    [1, 0, 1, 'after 16 min', 80, 30, 0, 20],
    [1, 0, 1, 'after a dismissal', 80, 30, 100, 20],
    [1, 0, 1, 'after the lean moved', 80, 30, 0, 20],
    [1, 4, 0, '', 80, 30, 100, 20],
    [1, 4, 1, '', 0, 0, 0, 20],
    [1, 4, 1, 'after 16 min', 80, 30, 100, 20],
    [1, 4, 1, 'after a dismissal', 80, 30, 100, 20],
    [1, 4, 1, 'after the lean moved', 80, 30, 100, 20],
    // cs.LG, cs.RO, area:cs and area:ai; two notable lanes: 4 + 146 + 60 vectors.
    [2, 0, 0, '', 160, 60, 0, 20],
    [2, 0, 1, '', 0, 0, 0, 20],
    [2, 0, 1, 'after 16 min', 160, 60, 0, 20],
    [2, 0, 1, 'after a dismissal', 160, 60, 210, 20],
    [2, 0, 1, 'after the lean moved', 160, 60, 0, 20],
    [2, 4, 0, '', 160, 60, 210, 20],
    [2, 4, 1, '', 0, 0, 0, 20],
    [2, 4, 1, 'after 16 min', 160, 60, 210, 20],
    [2, 4, 1, 'after a dismissal', 160, 60, 210, 20],
    [2, 4, 1, 'after the lean moved', 160, 60, 210, 20],
  ]);
  // The request is the app's: with `skipsSeen`, the walk sends none of the 30
  // newest papers of cs.LG that the filter holds (seeded as 2610.00001 on), and
  // the second page none of the first's.
  const heldBySeenFilter = new Set(Array.from({ length: 30 }, (_, index) => `2610.${String(index + 1).padStart(5, '0')}`));
  rows.forEach((row, index) => {
    if (row.categories === 1) assert.deepEqual(row.ids.filter(id => heldBySeenFilter.has(id)), [], `page ${row.page + 1} of ${row.likes} likes`);
    if (row.page === 1) assert.deepEqual(row.ids.filter(id => rows.slice(0, index).findLast(first => first.page === 0)!.ids.includes(id)), [], `a next page ${row.after} repeats no paper`);
  });
  for (const row of rows) {
    assert.equal(row.rowsReadBy.other, 0, 'every row read comes from a statement of a known kind');
    assert.ok(row.rowsReadBy.lanes >= row.returned.lanes && row.rowsReadBy.notable >= row.returned.notable);
    assert.ok(row.calls > 0 && row.wallMs > 0 && Number.isFinite(row.cpuMs));
  }
  assert.deepEqual(rows.filter(row => row.rowsWritten > 0).map(row => [row.categories, row.likes, row.page, row.rowsWritten]), [
    [1, 4, 0, 4],
    [2, 4, 0, 4],
  ], 'the first page keeps each like (liked_until)');
});
