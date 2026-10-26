import assert from 'node:assert/strict';
import test from 'node:test';

import { measureLaneReads } from './measure-lane-reads.ts';

test('the measurement pages a seeded local D1 through readFeedPage: rows by statement, vectors only with likes, the next page from the kept order', async () => {
  // Every leaf lane holds 40 papers, every area lane 100 and every notable lane
  // 3 of each of its ten years: under each lane's share, so each read returns
  // the lane. The seen filter holds 90 papers, more than the leaf lanes hold.
  const rows = await measureLaneReads(
    { leafRows: 40, areaRows: 100, notablePerYear: 3 },
    { readers: [['cs.LG'], ['cs.LG', 'cs.RO']], likes: 4, excluded: 10, seen: 90, repetitions: 1 },
  );
  const returned = rows.map(row => [row.categories, row.likes, row.page, row.after, row.returned.lanes, row.returned.notable, row.returned.vectors, row.papers]);
  assert.deepEqual(returned, [
    // cs.LG and area:ai; notable:cs.LG. With likes: the 4 likes' vectors, then
    // the 126 candidates neither liked nor excluded and the 30 notable ones. The
    // next page reads none of it from its kept order, but ranks again, as a first
    // page does, 16 minutes later (RANKING_KEPT_MS) or after a dismissal, which is
    // a negative: its vector is read even without likes. A lean that moved to
    // `relevance` changes `rankedBy` too.
    [1, 0, 0, '', 140, 30, 0, 20],
    [1, 0, 1, '', 0, 0, 0, 20],
    [1, 0, 1, 'after 16 min', 140, 30, 0, 20],
    [1, 0, 1, 'after a dismissal', 140, 30, 160, 20],
    [1, 0, 1, 'after the lean moved', 140, 30, 0, 20],
    [1, 4, 0, '', 140, 30, 160, 20],
    [1, 4, 1, '', 0, 0, 0, 20],
    [1, 4, 1, 'after 16 min', 140, 30, 160, 20],
    [1, 4, 1, 'after a dismissal', 140, 30, 160, 20],
    [1, 4, 1, 'after the lean moved', 140, 30, 160, 20],
    // cs.LG, cs.RO, area:cs and area:ai; two notable lanes: 4 + 266 + 60 vectors.
    [2, 0, 0, '', 280, 60, 0, 20],
    [2, 0, 1, '', 0, 0, 0, 20],
    [2, 0, 1, 'after 16 min', 280, 60, 0, 20],
    [2, 0, 1, 'after a dismissal', 280, 60, 330, 20],
    [2, 0, 1, 'after the lean moved', 280, 60, 0, 20],
    [2, 4, 0, '', 280, 60, 330, 20],
    [2, 4, 1, '', 0, 0, 0, 20],
    [2, 4, 1, 'after 16 min', 280, 60, 330, 20],
    [2, 4, 1, 'after a dismissal', 280, 60, 330, 20],
    [2, 4, 1, 'after the lean moved', 280, 60, 330, 20],
  ]);
  // The seen filter holds the newest papers of every asked lane, leaf and area,
  // as a feed without likes serves them: the leaf papers of one night come
  // first (cs.LG's 40, or both leaves' 80, seeded as 2610.00001 on), then the
  // area articles of that night, which are dated by day. A filter of leaf
  // papers only would leave every article unseen, and serve every page from them.
  const oneCategory = rows.find(row => row.categories === 1)!.seen;
  const twoCategories = rows.find(row => row.categories === 2)!.seen;
  const isArticle = (id: string) => id.startsWith('openalex:');
  assert.deepEqual(oneCategory.map(isArticle), [...Array(40).fill(false), ...Array(50).fill(true)]);
  assert.deepEqual(twoCategories.map(isArticle), [...Array(80).fill(false), ...Array(10).fill(true)]);
  assert.deepEqual(oneCategory.slice(0, 40), Array.from({ length: 40 }, (_, index) => `2610.${String(index + 1).padStart(5, '0')}`));
  // With `skipsSeen`, the walk sends none of the papers the filter holds, and
  // the second page none of the first's.
  rows.forEach((row, index) => {
    const held = new Set(row.seen);
    assert.deepEqual(row.ids.filter(id => held.has(id)), [], `page ${row.page + 1} of ${row.categories} categories, ${row.likes} likes`);
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
