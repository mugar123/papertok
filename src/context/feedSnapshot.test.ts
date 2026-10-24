import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/Paper.ts';
import { dropUnreachedPublications } from '../services/feedPublicationService.ts';
import { placeNotableCards } from '../utils/feedEnrichment.ts';
import { resumeIndex } from '../utils/feedMountWindow.ts';
import { createFeedResumeMemory, FEED_RESUME_STORAGE_PREFIX, forYouScrollKey } from '../utils/feedResumeMemory.ts';
import { joinFeedPage, notablePlaceAfterDismissal, reRankAfterReader } from './feedNotableCards.ts';
import { readFeedSnapshot, restoredReaderCardId, writeFeedSnapshot } from './feedSnapshot.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

// The account's For You snapshot in this browser, and `place`: the card For
// You was left on in this tab, as FeedContainer stores it for `placeAccount`.
function snapshots(place: { paperId: string; index: number } | null = null, placeAccount: string | null = 'test-user') {
  const storage = memoryStorage();
  const session = memoryStorage();
  if (place) session.setItem(`${FEED_RESUME_STORAGE_PREFIX}${forYouScrollKey(placeAccount)}`, JSON.stringify(place));
  const resumeMemory = createFeedResumeMemory({ storage: session });
  return {
    session: session.values,
    write: (papers: Paper[], page = 2, notableAfter: string | null = null) => writeFeedSnapshot('test-user', 'cs.AI', { papers, page, hasMore: true, notableAfter }, storage),
    read: () => readFeedSnapshot('test-user', 'cs.AI', { storage, resumeMemory })?.papers ?? null,
    restore: () => readFeedSnapshot('test-user', 'cs.AI', { storage, resumeMemory }),
    readerCard: (papers: Paper[]) => restoredReaderCardId('test-user', papers, resumeMemory),
  };
}

// One feed card in 15 is notable (placeNotableCards). After a reload the reader
// is back on the card they left, found by its id (resumeIndex, as FeedContainer
// restores it from the place it stored for the tab). A book in a saved
// snapshot is a card Crossref has since called one.
const card = (id: string, publicationType = 'article'): Paper => ({ id, title: `Synthetic paper ${id}`, abstract: '', authors: [], publicationType, sources: { primary: 'openalex', enrichedBy: [] } });
const notable = (id: string): Paper => ({ ...card(id), _notable: true });
const ids = (papers: Paper[]) => papers.map(paper => paper.id);
const asBooks = (papers: Paper[], books: Set<string>) => papers.map(paper => (books.has(paper.id) ? { ...paper, publicationType: 'book' } : paper));
// Where the reader meets each notable card, counted from 1.
const notableMet = (papers: Paper[]) => papers.flatMap((paper, index) => (paper._notable ? [index + 1] : []));

for (const past of [1, 2]) {
  test(`a notable card the reader passed stays behind them when cards before it are books in a restored snapshot (${past} card${past > 1 ? 's' : ''} past it)`, () => {
    const saved = placeNotableCards(Array.from({ length: 28 }, (_, index) => card(`card-${index}`)), [notable('notable-0'), notable('notable-1')]);
    assert.equal(saved[14].id, 'notable-0');
    const readerAt = 14 + past;
    const { write, read } = snapshots({ paperId: saved[readerAt].id, index: readerAt });
    // Two cards the reader passed are books.
    write(asBooks(saved, new Set(['card-3', 'card-5'])));
    const restored = read()!;
    const at = resumeIndex({ papers: restored, savedPaperId: saved[readerAt].id, savedIndex: readerAt });
    assert.ok(ids(restored).indexOf('notable-0') < at, 'the notable card the reader saw does not come again');
    assert.deepEqual(ids(restored.slice(at)), ids(saved.slice(readerAt)), 'the cards from the reader on keep their saved order');
  });
}

// The reader's own card is a book, and a card before it. Left out, their card
// was not there to come back to, and FeedContainer fell back to its saved
// index in the shorter list: a card past the next one.
for (const readerAt of [12, 13]) {
  test(`the reader comes back to their card when it and a card before it are books in a restored snapshot (card ${readerAt + 1})`, () => {
    const saved = placeNotableCards(Array.from({ length: 28 }, (_, index) => card(`card-${index}`)), [notable('notable-0'), notable('notable-1')]);
    const reader = saved[readerAt].id;
    const { write, read } = snapshots({ paperId: reader, index: readerAt });
    write(asBooks(saved, new Set(['card-5', reader])));
    const restored = read()!;
    const at = resumeIndex({ papers: restored, savedPaperId: reader, savedIndex: readerAt });
    assert.equal(restored[at]?.id, reader, 'they come back to their card');
    // The cards they met, then the restored list after their card.
    assert.deepEqual(notableMet([...saved.slice(0, readerAt + 1), ...restored.slice(at + 1)]), [15, 30]);
  });
}

// For You's place was one for the tab, whatever the account: after a sign-out
// and another sign-in, the new account's restore took the old place's card
// for its reader's, and counted the cards before it as met.
for (const placeAccount of ['another-account', null]) {
  test(`a place ${placeAccount ? 'another account' : 'a guest'} left in this tab does not move this account's restore`, () => {
    const saved = placeNotableCards(Array.from({ length: 28 }, (_, index) => card(`b-${index}`)), [notable('b-notable-0'), notable('b-notable-1')]);
    const { write, read, readerCard } = snapshots({ paperId: 'a-20', index: 20 }, placeAccount);
    // The eighth card is a book, which this reader has not reached.
    write(asBooks(saved, new Set(['b-7'])));
    const restored = read()!;
    assert.ok(!ids(restored).includes('b-7'), 'the book leaves');
    // With no place of their own, the reader opens on the first card, and the
    // next card takes the book's place. The last notable card, at the end of
    // the list, has no other card after the book's to keep its place, and leaves.
    assert.deepEqual(notableMet(restored), [15]);
    assert.equal(readerCard(restored), null, 'until the feed reports a card, the reader is on the first one');
  });
}

// A snapshot keeps the list's first thirty cards. Restored for a reader past
// them, it put the reader on its last card, a notable one they had met, and
// the next notable card came more than fifteen cards later.
test('a reader who left past the cards a snapshot keeps starts For You again from its first card, not on a card they met', () => {
  const saved = placeNotableCards(Array.from({ length: 56 }, (_, index) => card(`card-${index}`)), ['notable-0', 'notable-1', 'notable-2', 'notable-3'].map(notable));
  assert.equal(saved.length, 60);
  // The reader left For You on the forty-first card.
  const readerAt = 40;
  const { write, read, session } = snapshots({ paperId: saved[readerAt].id, index: readerAt });
  write(saved, 3);
  assert.equal(read(), null, 'the snapshot does not hold their card');
  assert.equal(read(), null, 'and is not restored on the next read either, with the reader on its first card');
  // FeedContainer then opens the new load on its first card.
  assert.equal(session.size, 0, 'their place is gone');
});

// A snapshot is restored for fifteen minutes after its page loaded. Expired,
// or dropped by another tab of the account, it left the reader's place
// behind, and For You opened its new first page at that index: a reader who
// was on a notable card landed on the new page's.
for (const state of ['expired', 'missing']) {
  test(`with its snapshot ${state}, the reader's place goes and For You opens its new first page on the first card`, (t) => {
    const saved = placeNotableCards(Array.from({ length: 28 }, (_, index) => card(`card-${index}`)), [notable('notable-0'), notable('notable-1')]);
    const { write, read, readerCard, session } = snapshots({ paperId: 'notable-0', index: 14 });
    if (state === 'expired') {
      write(saved);
      const savedAt = Date.now();
      t.mock.method(Date, 'now', () => savedAt + 16 * 60 * 1000);
    }
    assert.equal(read(), null);
    assert.equal(session.size, 0, 'their place is gone');
    const fresh = placeNotableCards(Array.from({ length: 21 }, (_, index) => card(`fresh-${index}`)), [notable('fresh-notable-0')]);
    assert.equal(readerCard(fresh), null, 'the new page opens on its first card');
  });
}

// The reader dismissed the notable card at 14, and the next one kept its place:
// the thirtieth card they meet, the list's twenty-ninth.
test('a notable card the reader has not reached stays ahead of them in a restored snapshot', () => {
  const { write, read } = snapshots({ paperId: 'card-16', index: 16 });
  const saved = [...Array.from({ length: 28 }, (_, index) => card(`card-${index}`)), notable('notable-1')];
  write(saved);
  const restored = read()!;
  const at = resumeIndex({ papers: restored, savedPaperId: 'card-16', savedIndex: 16 });
  assert.ok(ids(restored).indexOf('notable-1') > at, 'the reader still reaches it');
  assert.deepEqual(ids(restored), ids(saved), 'with no book to leave, the restore keeps the saved list');
});

// The reader dismissed the notable card they were on, the list's last one, and
// the tab reloaded. The restored list no longer held it, and the next page
// counted from the notable card before it: 3 cards after the dismissed one.
test('after a reload, the next page puts its notable card fifteen cards after a notable card the reader dismissed', () => {
  const shown = placeNotableCards(Array.from({ length: 36 }, (_, index) => card(`card-${index}`)), [notable('notable-0'), notable('notable-1')]);
  assert.equal(shown[29].id, 'notable-1');
  const notableAfter = notablePlaceAfterDismissal(shown, 'notable-1', 'notable-1', null);
  const list = shown.filter(paper => paper.id !== 'notable-1');
  // The reader is on the card after it, the thirtieth of the list.
  const { write, restore } = snapshots({ paperId: 'card-28', index: 29 });
  write(list, 3, notableAfter);
  const snapshot = restore()!;
  const page = Array.from({ length: 21 }, (_, index) => card(`page-${index}`));
  const joined = joinFeedPage(snapshot.papers, page, [notable('page-notable-0'), notable('page-notable-1')], {
    reset: false, keepThroughVisible: false, visiblePaperId: 'card-28', notableAfter: snapshot.notableAfter,
  });
  // The cards they met, the dismissed one included, then the list after their card.
  assert.deepEqual(notableMet([...shown.slice(0, 31), ...joined.slice(30)]), [15, 30, 45]);
});

// The re-rank locks the reader's card and the two after it, so a notable
// card one place early among them stayed there: the reader met it fourteenth.
test('a book known at the restore after the reader leaves its place to the next card, so the notable card is still the fifteenth they meet', () => {
  const saved = placeNotableCards(Array.from({ length: 28 }, (_, index) => card(`card-${index}`)), [notable('notable-0')]);
  assert.equal(saved[14].id, 'notable-0');
  // The reader left on the twelfth card; the fourteenth is a book.
  const readerAt = 11;
  const { write, read } = snapshots({ paperId: 'card-11', index: readerAt });
  write(asBooks(saved, new Set(['card-13'])));
  const restored = read()!;
  assert.ok(!ids(restored).includes('card-13'));
  const at = resumeIndex({ papers: restored, savedPaperId: 'card-11', savedIndex: readerAt });
  assert.equal(at, readerAt, 'they come back to their card');
  // The cards they met, then the restored list after their card.
  assert.deepEqual(notableMet([...saved.slice(0, readerAt + 1), ...restored.slice(at + 1)]), [15]);
});

// The snapshot restore runs on every page, and only the feed reports the card
// the reader is on. After a reload on another page, a late Crossref answer
// had no card: the books left and the other cards kept their order, so a
// notable card came one place early, and stayed there when it was among the
// cards the next re-rank locks (the reader's card and the two after it).
test('after a reload on another page, a late book leaves each notable card the fifteenth the reader meets, through the next re-rank', () => {
  const shown = placeNotableCards(Array.from({ length: 43 }, (_, index) => card(`card-${index}`)), ['notable-0', 'notable-1', 'notable-2'].map(notable));
  // FeedContainer stored the reader's place on For You: the twelfth card.
  const readerAt = 11;
  const reader = shown[readerAt].id;
  const { readerCard } = snapshots({ paperId: reader, index: readerAt });
  // The restore stands the card For You opens on in for the reader's.
  const visible = readerCard(shown);
  assert.equal(visible, reader);
  // Crossref answers after the restore: the fourteenth card is a book.
  const answered = dropUnreachedPublications(shown, [{ ...card('card-13'), publicationType: 'book' }], visible);
  assert.ok(!answered.some(paper => paper.id === 'card-13'), 'the book leaves');
  const met = shown.slice(0, readerAt + 1);
  const after = (papers: Paper[]) => papers.slice(papers.findIndex(paper => paper.id === reader) + 1);
  assert.deepEqual(notableMet([...met, ...after(answered)]), [15, 30, 45]);
  // The reader opens the feed, which reports their card, and a long read
  // re-ranks; the ranking stands in as the queue reversed.
  const reRanked = reRankAfterReader(answered, [reader, reader], others => [...others].reverse())!;
  assert.deepEqual(notableMet([...met, ...after([...reRanked.locked, ...reRanked.queue])]), [15, 30, 45]);
});
