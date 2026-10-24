import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/Paper.ts';
import { placeNotableCards } from '../utils/feedEnrichment.ts';
import { readSeenPaperIds } from '../utils/userScopedStorage.ts';
import { cardsBeforePage, joinFeedPage, notablePassedOver, notablePlaceAfterDismissal, notableRequest, reRankAfterReader } from './feedNotableCards.ts';
import { recordCardView, seenPapersForAccount } from './feedViewedPapers.ts';

const records = (prefix: string, count = 15): Paper[] => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`, title: `${prefix} paper ${index}`, abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] },
}));
const notable = (id: string): Paper => ({ id, title: `${id} paper`, abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] }, _notable: true });
const notableAt = (papers: Paper[]) => papers.flatMap((paper, index) => (paper._notable ? [[index, paper.id]] : []));
// Where the reader meets each notable card, counted from 1: the cards they
// met (`met`), then the list after `fromId`.
const metNotableAt = (met: Paper[], list: Paper[], fromId: string) => (
  [...met, ...list.slice(list.findIndex(paper => paper.id === fromId) + 1)].flatMap((paper, index) => (paper._notable ? [index + 1] : []))
);
// A later page, and a first screen: a reset that replaces the list.
const later = { reset: false, keepThroughVisible: false, visiblePaperId: null };
const firstScreen = { reset: true, keepThroughVisible: false, visiblePaperId: null };
// The largest page a load can show: the corpus's fifteen and the follows' six,
// and after the first screen up to ten exploration cards (FeedContext).
const FIRST_SCREEN = 21;
const LATER_PAGE = 31;
// The ranking, stood in for by the queue's new order: reversed, or as it is.
const reversed = (others: Paper[]) => [...others].reverse();
const asItIs = (others: Paper[]) => others;

test('a page asks for the unseen notable papers its places can take, and two more for any the reader already knows', () => {
  // A first screen of up to 21 cards has one place (the fifteenth), a later page of up to 31 two.
  assert.equal(notableRequest([], FIRST_SCREEN, null), 3);
  assert.equal(notableRequest([], LATER_PAGE, null), 4);
});

test("the feed's fifteenth card is the corpus's notable one, counted from the cards already shown", () => {
  // The corpus's fifteen, and the two unseen notable papers it adds after them.
  const others = records('corpus');
  const offered = [notable('notable-0'), notable('notable-1')];
  // Every paper of the corpus's page, and one notable card, fifteenth.
  const shown = joinFeedPage([], others, offered, firstScreen);
  assert.equal(shown.length, 16);
  assert.deepEqual(notableAt(shown), [[14, 'notable-0']]);

  // Ten cards on screen: the next page's fifth card is the feed's fifteenth.
  const next = joinFeedPage(records('shown', 10), others, offered, later);
  assert.equal(next.length, 26);
  assert.deepEqual(notableAt(next), [[14, 'notable-0']]);
});

// A follow change refreshes the ranking but the reader keeps their place.
test('a refresh that keeps the reader\'s place keeps the cards through the visible one, and counts the next notable card from theirs', () => {
  const onScreen = records('shown', 20).map((paper, index) => ({ ...paper, _notable: index === 14 }));
  const keeping = { reset: true, keepThroughVisible: true, visiblePaperId: 'shown-16' };
  // Through the visible card and the two after it, as a re-rank locks them.
  assert.deepEqual(cardsBeforePage(onScreen, keeping).map(paper => paper.id), onScreen.slice(0, 19).map(paper => paper.id));
  const refreshed = joinFeedPage(onScreen, records('corpus'), [notable('notable-0')], keeping);
  assert.deepEqual(refreshed.slice(0, 19), onScreen.slice(0, 19), 'through the visible card the list stays');
  assert.deepEqual(notableAt(refreshed), [[14, 'shown-14'], [29, 'notable-0']], 'the fresh page follows, its notable card fifteen after theirs');
  // A plain reset replaces the list.
  assert.deepEqual(cardsBeforePage(onScreen, firstScreen), []);
});

test('a re-rank reorders the cards after the reader and leaves every notable card at its place', () => {
  const shown = placeNotableCards(records('card', 42), ['notable-0', 'notable-1', 'notable-2'].map(notable), []);
  assert.deepEqual(notableAt(shown), [[14, 'notable-0'], [29, 'notable-1'], [44, 'notable-2']]);
  const others = (papers: Paper[]) => papers.filter(paper => !paper._notable).map(paper => paper.id);
  // The reader before every notable card, then past the first.
  for (const visible of ['card-3', 'card-15']) {
    const { locked, queue } = reRankAfterReader(shown, [null, visible], reversed)!;
    const reRanked = [...locked, ...queue];
    assert.deepEqual(notableAt(reRanked), notableAt(shown), `the reader on ${visible}`);
    const through = shown.findIndex(paper => paper.id === visible) + 1;
    assert.deepEqual(reRanked.slice(0, through), shown.slice(0, through), 'the cards through the reader stay');
    assert.notDeepEqual(others(reRanked), others(shown), 'the cards after them are reordered');
    assert.deepEqual(others(reRanked).sort(), others(shown).sort(), 'and none is left out');
  }
});

// A re-rank orders the cards after the reader's card and the two after it.
// Three cards before a notable last card, that card is all there is: placed
// among no other cards, it had no place and left the list (62ed02ee).
test('a re-rank with only a notable card after the reader leaves the list as it is', () => {
  const shown = placeNotableCards(records('card', 42), ['notable-0', 'notable-1', 'notable-2'].map(notable), []);
  assert.equal(shown.at(-1)?.id, 'notable-2');
  assert.equal(reRankAfterReader(shown, [null, shown.at(-4)!.id], reversed), null);
});

// The reader meets the card they dismiss, so it counts towards the next
// notable card. A re-rank that counted the list instead put that card one
// place later: the sixteenth the reader met.
test('Not interested on a card leaves the next notable card the fifteenth the reader meets, through the re-ranks after it', () => {
  const shown = placeNotableCards(records('card', 43), ['notable-0', 'notable-1', 'notable-2'].map(notable), []);
  // A card between two notable ones, then the notable card itself.
  for (const dismissedAt of [18, 14]) {
    const dismissed = shown[dismissedAt];
    const next = shown[dismissedAt + 1];
    // Not interested takes the card out of the list, and the reader is on the
    // next one, which the re-rank after it anchors on (markNotInterested).
    const { locked, queue } = reRankAfterReader(shown.filter(paper => paper !== dismissed), [next.id, next.id], reversed)!;
    const afterDismissal = [...locked, ...queue];
    // The reader met the cards through the dismissed one, and is on the next.
    const met = [...shown.slice(0, dismissedAt + 1), next];
    assert.deepEqual(metNotableAt(met, afterDismissal, next.id), [15, 30, 45], `after ${dismissed.id} left`);
    // A long read on that card re-ranks again.
    const again = reRankAfterReader(afterDismissal, [next.id, next.id], reversed)!;
    assert.deepEqual(metNotableAt(met, [...again.locked, ...again.queue], next.id), [15, 30, 45], `after ${dismissed.id} left and a second re-rank`);
  }
});

// The reader dismissed the list's last notable card, which they had met. The
// next page counted its place from the notable card before that one, more than
// fifteen cards back, and put its notable card on the first card after the
// reader's: 4 to 10 cards after the dismissed one (the review's probe).
for (const readOn of [0, 2, 6]) {
  test(`Not interested on the list's last notable card leaves the next page's notable card the fifteenth after it (${readOn} cards read on)`, () => {
    // Notable cards fifteenth and thirtieth, eight cards after the second; the reader is on the second.
    const shown = placeNotableCards(records('card', 36), [notable('notable-0'), notable('notable-1')]);
    assert.equal(shown[29].id, 'notable-1');
    // markNotInterested: the card leaves, the reader is on the next one, the re-rank anchors on it.
    const notableAfter = notablePlaceAfterDismissal(shown, 'notable-1', 'notable-1', null);
    const next = shown[30];
    const { locked, queue } = reRankAfterReader(shown.filter(paper => paper.id !== 'notable-1'), [next.id, next.id], asItIs)!;
    const afterDismissal = [...locked, ...queue];
    const readerAt = afterDismissal.indexOf(next) + readOn;
    const visible = afterDismissal[readerAt].id;
    const met = [...shown.slice(0, 30), ...afterDismissal.slice(afterDismissal.indexOf(next), readerAt + 1)];
    const asked = notableRequest(afterDismissal, LATER_PAGE, visible, notableAfter);
    const joined = joinFeedPage(afterDismissal, records('corpus-2', 21), Array.from({ length: asked }, (_, index) => notable(`page-notable-${index}`)), { ...later, visiblePaperId: visible, notableAfter });
    assert.deepEqual(metNotableAt(met, joined, visible), [15, 30, 45, 60]);
  });
}

// Not interested on another page (EntityExplorer) can take out a notable card
// the reader has not reached. They never meet it, so its place stays open.
test('a notable card dismissed before the reader reaches it leaves its place to the next page', () => {
  const shown = placeNotableCards(records('card', 36), [notable('notable-0'), notable('notable-1')]);
  const notableAfter = notablePlaceAfterDismissal(shown, 'notable-1', 'card-3', null);
  const joined = joinFeedPage(shown.filter(paper => paper.id !== 'notable-1'), records('corpus-2', 21), [notable('page-notable-0'), notable('page-notable-1')], { ...later, visiblePaperId: 'card-3', notableAfter });
  assert.deepEqual(metNotableAt(shown.slice(0, 4), joined, 'card-3'), [15, 30, 45]);
});

// The card before a dismissed notable card's place leaves too: the reader met
// both, and the place moves onto the card before them.
test('Not interested on the card a dismissed notable card followed keeps the next page counting from that place', () => {
  const shown = placeNotableCards(records('card', 36), [notable('notable-0'), notable('notable-1')]);
  const notableAfter = notablePlaceAfterDismissal(shown, 'notable-1', 'notable-1', null);
  const afterNotable = shown.filter(paper => paper.id !== 'notable-1');
  // On card-30, the reader dismisses card-27, the card before the notable card's place, on another page.
  const placeAfter = notablePlaceAfterDismissal(afterNotable, 'card-27', 'card-30', notableAfter);
  const list = afterNotable.filter(paper => paper.id !== 'card-27');
  const joined = joinFeedPage(list, records('corpus-2', 21), ['page-notable-0', 'page-notable-1'].map(notable), { ...later, visiblePaperId: 'card-30', notableAfter: placeAfter });
  assert.deepEqual(metNotableAt(shown.slice(0, 33), joined, 'card-30'), [15, 30, 45, 60]);
});

test('the related papers a like brings join the cards after the reader, and every notable card keeps its place', () => {
  const shown = placeNotableCards(records('card', 42), ['notable-0', 'notable-1', 'notable-2'].map(notable), []);
  const { locked, queue } = reRankAfterReader(shown, ['card-3', 'card-3'], reversed, records('related', 5))!;
  const expanded = [...locked, ...queue];
  assert.equal(expanded.filter(paper => paper.id.startsWith('related-')).length, 5, 'the five related papers are in the feed');
  assert.equal(expanded.length, 50);
  assert.deepEqual(notableAt(expanded), [[14, 'notable-0'], [29, 'notable-1'], [44, 'notable-2']]);
});

// The page joins the list as it is when the page arrives. Placed on the list
// as it was when the load started, its notable card came as many cards later
// as the like had inserted (the review's probe: 20 cards after the last one).
test('a page that loads while a like inserts related papers puts its notable card fifteen cards after the last one', () => {
  // Twenty cards on screen and a notable one fifteenth; the reader is on the fourth.
  const shown = placeNotableCards(records('card', 20), [notable('notable-0')]);
  // The load asks with the list it found.
  const asked = notableRequest(shown, LATER_PAGE, null);
  const offered = ['notable-1', 'notable-2', 'notable-3'].slice(0, asked).map(notable);
  // The like inserts its related papers while the page loads.
  const { locked, queue } = reRankAfterReader(shown, ['card-3', 'card-3'], asItIs, records('related', 5))!;
  const current = [...locked, ...queue];
  assert.deepEqual(notableAt(current), [[14, 'notable-0']], 'the insert keeps the notable card on screen at its place');
  const joined = joinFeedPage(current, records('corpus-1'), offered, later);
  assert.equal(joined.length, 26 + 16);
  assert.deepEqual(notableAt(joined), [[14, 'notable-0'], [29, 'notable-1']]);
});

// The related papers a like brings follow the last notable card when they do
// not fit before it. Ten cards after it and five related ones passed its next
// place, and the page counted that place as gone: it put its notable card a
// place later, and the reader met thirty cards between two notable ones.
test('a page puts its first notable card in the place the related papers a like inserted have passed', () => {
  // Notable cards fifteenth and thirtieth, ten cards after the second; the reader is on the fourth.
  const shown = placeNotableCards(records('card', 38), [notable('notable-0'), notable('notable-1')]);
  assert.deepEqual(notableAt(shown).map(([index]) => index), [14, 29]);
  const { locked, queue } = reRankAfterReader(shown, ['card-3', 'card-3'], asItIs, records('related', 5))!;
  const current = [...locked, ...queue];
  assert.equal(current.length, 45);
  assert.deepEqual(notableAt(current).map(([index]) => index), [14, 29], 'fifteen other cards follow the second notable card');
  const reader = { reset: false, keepThroughVisible: false, visiblePaperId: 'card-3' };
  const asked = notableRequest(current, LATER_PAGE, 'card-3');
  const joined = joinFeedPage(current, records('corpus-2'), Array.from({ length: asked }, (_, index) => notable(`page-notable-${index}`)), reader);
  assert.deepEqual(metNotableAt(shown.slice(0, 4), joined, 'card-3'), [15, 30, 45, 60]);
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

// The notable steps of a load, in the order FeedContext.loadPapers runs them,
// over a corpus that offers the reader's unseen notable papers in `order`
// after the page's fifteen: the request, the papers the feed cannot show, the
// join, and the notable cards that took a place joining the session's seen set.
function notableLoads(order: string[], { saved, storage, seen }: { saved: Set<string>; storage: ReturnType<typeof memoryStorage>; seen: Set<string> }) {
  let list: Paper[] = [];
  const asked: Array<{ notable: number; seen: Set<string> }> = [];
  const isAvailable = (paper: Paper) => !saved.has(paper.id) && !seen.has(paper.id);
  const load = (page: number) => {
    const reset = page === 0;
    const join = reset ? firstScreen : later;
    const notableCount = notableRequest(cardsBeforePage(list, join), reset ? FIRST_SCREEN : LATER_PAGE, null);
    asked.push({ notable: notableCount, seen: new Set(seen) });
    const offered = order.filter(id => !seen.has(id)).slice(0, notableCount).map(notable);
    const papers = [...records(`corpus-${page}`), ...offered];
    notablePassedOver(papers, isAvailable).forEach(paper => {
      recordCardView(paper.id, 'test-user', { activeUserId: 'test-user', signedInUid: 'test-user', sessionSeen: seen }, storage);
    });
    const available = papers.filter(isAvailable);
    list = joinFeedPage(list, available.filter(paper => !paper._notable), available.filter(paper => paper._notable), join);
    available.forEach(paper => { if (!paper._notable || list.includes(paper)) seen.add(paper.id); });
    return list;
  };
  return { load, asked };
}

// The reader saved a notable paper elsewhere. The corpus leaves out only the
// seen filter and the likes and saves it ranks by, so it offers that paper
// first, in one order of unseen notable papers. The feed leaves it out, and it
// must not take a place another notable paper could fill.
test('a notable paper the reader already saved leaves its place to the next one, and the next pages ask past it', () => {
  const { load, asked } = notableLoads(['saved-classic', 'notable-a', 'notable-b', 'notable-c', 'notable-d'], {
    saved: new Set(['saved-classic']), storage: memoryStorage(), seen: new Set(),
  });
  assert.deepEqual(notableAt(load(0)), [[14, 'notable-a']], 'the first screen has its notable card fifteenth');
  load(1);
  const list = load(2);
  assert.deepEqual(notableAt(list), [[14, 'notable-a'], [29, 'notable-b'], [44, 'notable-c']]);
  // Each page's places, and two spares.
  assert.deepEqual(asked.map(request => request.notable), [3, 4, 4]);
  assert.equal(asked[1].seen.has('saved-classic'), true, 'the corpus is told the reader knows it');
  assert.ok(!list.some(paper => paper.id === 'saved-classic'));
});

// More known papers at the top of the corpus's order than a page has spares:
// the first screen has no notable card. A session starts from the seen papers
// this browser keeps, so without them every session's first screen lost it.
test('notable papers the reader already knew cost one first screen its notable card in this browser, not every session', () => {
  const storage = memoryStorage();
  const known = ['saved-1', 'saved-2', 'saved-3'];
  const firstScreens: unknown[] = [];
  for (let session = 0; session < 2; session += 1) {
    const { load } = notableLoads([...known, 'notable-a', 'notable-b', 'notable-c'], {
      saved: new Set(known), storage, seen: seenPapersForAccount('test-user', storage),
    });
    firstScreens.push(notableAt(load(0)));
  }
  assert.deepEqual(firstScreens, [[], [[14, 'notable-a']]]);
  assert.deepEqual([...readSeenPaperIds('test-user', storage)], known, 'this browser keeps them as viewed');
});
