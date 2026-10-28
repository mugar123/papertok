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
    // `relevance` changes `rankedBy` too. The notable reads return the lane's
    // 30 rows, then the 30 of the day's slice that its lookup offers.
    [1, 0, 0, '', 140, 60, 0, 20],
    [1, 0, 1, '', 0, 0, 0, 20],
    [1, 0, 1, 'after 16 min', 140, 60, 0, 20],
    [1, 0, 1, 'after a dismissal', 140, 60, 160, 20],
    [1, 0, 1, 'after the lean moved', 140, 60, 0, 20],
    [1, 4, 0, '', 140, 60, 160, 20],
    [1, 4, 1, '', 0, 0, 0, 20],
    [1, 4, 1, 'after 16 min', 140, 60, 160, 20],
    [1, 4, 1, 'after a dismissal', 140, 60, 160, 20],
    [1, 4, 1, 'after the lean moved', 140, 60, 160, 20],
    // cs.LG, cs.RO, area:cs and area:ai; two notable lanes: 4 + 266 + 60 vectors.
    [2, 0, 0, '', 280, 120, 0, 20],
    [2, 0, 1, '', 0, 0, 0, 20],
    [2, 0, 1, 'after 16 min', 280, 120, 0, 20],
    [2, 0, 1, 'after a dismissal', 280, 120, 330, 20],
    [2, 0, 1, 'after the lean moved', 280, 120, 0, 20],
    [2, 4, 0, '', 280, 120, 330, 20],
    [2, 4, 1, '', 0, 0, 0, 20],
    [2, 4, 1, 'after 16 min', 280, 120, 330, 20],
    [2, 4, 1, 'after a dismissal', 280, 120, 330, 20],
    [2, 4, 1, 'after the lean moved', 280, 120, 330, 20],
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
  // Not interested exists only on a card the reader was served: the dismissal
  // rows dismiss a paper of the first page before them, and no other row does.
  rows.forEach((row, index) => {
    const firstPage = rows.slice(0, index).findLast(earlier => earlier.page === 0);
    if (row.after === 'after a dismissal') assert.ok(row.dismissed !== null && firstPage!.ids.includes(row.dismissed), `a dismissal of ${row.categories} categories, ${row.likes} likes is of a paper page 1 served`);
    else assert.equal(row.dismissed, null);
  });
  for (const row of rows) {
    assert.equal(row.rowsReadBy.other, 0, 'every row read comes from a statement of a known kind');
    assert.ok(row.rowsReadBy.lanes >= row.returned.lanes && row.rowsReadBy.notable >= row.returned.notable);
    assert.ok(row.calls > 0 && row.wallMs > 0 && Number.isFinite(row.cpuMs));
  }
  // ENG-150. A page that ranks reads each of a notable lane's 30 rows once, in
  // its index's order, and at most the one index entry past them that ends the
  // range, then looks up the stored row of each of the day's slice, here all
  // 30, at two rows read an id: its JSON value and the row. Numbering the years
  // in SQL read about eight rows a row.
  for (const row of rows.filter(ranked => ranked.returned.lanes > 0)) {
    const perLane = 30 + 2 * 30;
    assert.ok(
      row.rowsReadBy.notable >= row.categories * perLane && row.rowsReadBy.notable <= row.categories * (perLane + 1),
      `${row.rowsReadBy.notable} notable rows read for ${row.categories} categories, ${row.likes} likes, page ${row.page + 1} ${row.after}`,
    );
  }
  // A lookup by id reads two rows an id, not three: every candidate has a
  // vector, and every id the walk and the page read has a stored row. Likes
  // add `keepLiked`, which writes and returns no row.
  for (const row of rows) {
    const label = `${row.categories} categories, ${row.likes} likes, page ${row.page + 1} ${row.after}`;
    assert.equal(row.rowsReadBy.vectors, 2 * row.returned.vectors, `vector rows of ${label}`);
    if (row.likes === 0) assert.equal(row.rowsReadBy.works, 2 * row.returned.works, `works rows of ${label}`);
  }
  assert.deepEqual(rows.filter(row => row.rowsWritten > 0).map(row => [row.categories, row.likes, row.page, row.rowsWritten]), [
    [1, 4, 0, 4],
    [2, 4, 0, 4],
  ], 'the first page keeps each like (liked_until)');
});

// A page that serves no paper, or falls back on papers the filter holds, is not
// the walk the rows measure, and the dismissal rows would have nothing to
// dismiss or would not dismiss a paper the first page served.
test('the measurement stops when page 1 serves no paper', async () => {
  await assert.rejects(
    measureLaneReads({ leafRows: 0, areaRows: 0, notablePerYear: 0 }, { readers: [['cs.LG']], likes: 0, excluded: 0, seen: 0, repetitions: 1 }),
    /Page 1 served 0 papers, 0 of them held by the seen filter/,
  );
});

test('the measurement stops when the seen filter holds every paper of the lanes and page 1 falls back on them', async () => {
  // cs.LG's lane and area:ai's hold 5 papers each, and the filter all 10; the 2
  // excluded ones are left out of the 8 the page falls back on.
  await assert.rejects(
    measureLaneReads({ leafRows: 5, areaRows: 5, notablePerYear: 0 }, { readers: [['cs.LG']], likes: 0, excluded: 2, seen: 10, repetitions: 1 }),
    /Page 1 served 8 papers, 8 of them held by the seen filter/,
  );
});

test('the measurement stops when the lanes run out on page 2', async () => {
  // The lanes hold 12 papers and the filter 2: page 1 serves the other 10 and
  // page 2 finds none.
  await assert.rejects(
    measureLaneReads({ leafRows: 6, areaRows: 6, notablePerYear: 0 }, { readers: [['cs.LG']], likes: 0, excluded: 2, seen: 2, repetitions: 1 }),
    /Page 2 served 0 papers, 0 of them held by the seen filter/,
  );
});

test('the measurement stops when the corpus holds fewer papers than its seen filter, excluded papers and likes ask for', async () => {
  // 10 papers in the lanes; 2 excluded and 20 liked.
  await assert.rejects(
    measureLaneReads({ leafRows: 5, areaRows: 5, notablePerYear: 1 }, { readers: [['cs.LG']], likes: 20, excluded: 2, seen: 4, repetitions: 1 }),
    /1-category reader's lanes hold 10 papers, fewer than the 22 its seen filter, excluded papers and likes ask for/,
  );
});
