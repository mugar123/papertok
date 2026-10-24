import type { Paper } from '../models/paper.ts';
import { joinNotablePage, keepNotablePlaces, notablePlaces } from '../utils/feed-enrichment.ts';
import { mergeFreshFeedPage, splitFeedForReRank } from '../utils/feed-re-rank-split.ts';

// Notable papers a page asks for beyond its places. The corpus leaves out the
// papers in the seen filter and the likes and saves it ranks by, not every
// paper the reader liked, saved, read or dismissed: the feed drops those
// (notablePassedOver), and a spare takes the place.
const NOTABLE_SPARE = 2;

/**
 * How a page joins the list: a refresh replaces it, keeping the cards through
 * the visible one when asked. `notableAfter` is the card just before a notable
 * card the reader met and dismissed (notablePlaceAfterDismissal).
 */
type PageJoin = { reset: boolean; keepThroughVisible: boolean; visiblePaperId: string | null; notableAfter?: string | null };

/**
 * The cards a page follows: the whole list on a later page, the cards through
 * the visible one when a refresh keeps the reader's place (mergeFreshFeedPage),
 * none on a plain reset.
 */
export function cardsBeforePage(papers: Paper[], { reset, keepThroughVisible, visiblePaperId }: PageJoin) {
  if (!reset) return papers;
  return keepThroughVisible ? mergeFreshFeedPage(papers, [], { anchorPaperIds: [visiblePaperId] }) : [];
}

// The cards the reader is on or about to reach, which a page's notable places
// do not move (joinNotablePage): those a re-rank locks.
const reachedCards = (cards: Paper[], visiblePaperId: string | null) => (
  splitFeedForReRank(cards, { anchorPaperIds: [visiblePaperId] }).locked.length
);

/**
 * How many unseen notable papers a page asks the corpus for: one for each
 * place of the largest page the load can show (`largestPage` other cards)
 * after `cardsBefore`, and NOTABLE_SPARE more.
 */
export function notableRequest(cardsBefore: Paper[], largestPage: number, visiblePaperId: string | null, notableAfter: string | null = null) {
  return notablePlaces(cardsBefore, largestPage, reachedCards(cardsBefore, visiblePaperId), notableAfter) + NOTABLE_SPARE;
}

/**
 * The card just before the last notable place the reader met that has no
 * notable card, once `removedId` leaves `cards` (Not interested); `notableAfter`
 * is the one known before. A notable card the reader met counts in their
 * fifteen after it leaves, so the next page counts from its place. When the
 * card just before that place leaves too, the card before it takes its role.
 * A notable card the reader has not reached gives its place to the next one
 * (withoutDismissedCard).
 */
export function notablePlaceAfterDismissal(cards: Paper[], removedId: string, visiblePaperId: string | null, notableAfter: string | null) {
  const removedAt = cards.findIndex(paper => paper.id === removedId);
  const markedAt = notableAfter === null ? -1 : cards.findIndex(paper => paper.id === notableAfter);
  const met = removedAt > 0 && removedAt <= Math.max(0, cards.findIndex(paper => paper.id === visiblePaperId));
  return met && markedAt <= removedAt && (cards[removedAt]._notable || markedAt === removedAt)
    ? cards[removedAt - 1].id
    : notableAfter;
}

/**
 * `cards` without `removedId` (Not interested). A card through the visible one
 * counts in the reader's fifteen, so the cards after it move up. One after it,
 * which another page can dismiss, they never meet: as with a book taken out
 * (dropUnreachedPublications), the next card takes its place and every notable
 * card keeps its own. A notable card's place takes the next notable card, so
 * the list's last notable place is left for the next page (joinNotablePage).
 */
export function withoutDismissedCard(cards: Paper[], removedId: string, visiblePaperId: string | null) {
  const unreached = cards.slice(Math.max(0, cards.findIndex(paper => paper.id === visiblePaperId)) + 1);
  const kept = unreached.filter(paper => paper.id !== removedId);
  if (kept.length === unreached.length) return cards.filter(paper => paper.id !== removedId);
  return [
    ...cards.slice(0, cards.length - unreached.length),
    ...keepNotablePlaces(unreached, kept.filter(paper => !paper._notable), kept.filter(paper => paper._notable)),
  ];
}

/**
 * The notable papers of a page the feed does not show (`isAvailable`), ones
 * the reader liked, saved, read or dismissed elsewhere. They count as viewed:
 * the corpus offers unseen notable papers in one order, and would send one
 * again in a place of every page and every session.
 */
export function notablePassedOver(papers: Paper[], isAvailable: (paper: Paper) => boolean) {
  return papers.filter(paper => paper._notable && !isAvailable(paper));
}

/**
 * The list with a page joined: the cards the page follows on the list as it
 * is now (cardsBeforePage), then the page's other cards and its notable cards
 * at their places (joinNotablePage), each card once. While the page loaded,
 * late answers may have filled or removed cards and a like may have inserted
 * some, so the places are counted on that list too: a place it has passed
 * with no notable card, after the cards the reader reached, takes the page's
 * first one.
 */
export function joinFeedPage(shown: Paper[], others: Paper[], notable: Paper[], join: PageJoin) {
  const kept = cardsBeforePage(shown, join);
  const keptIds = new Set(kept.map(paper => paper.id));
  const isNew = (paper: Paper) => !keptIds.has(paper.id);
  return joinNotablePage(kept, others.filter(isNew), notable.filter(isNew), reachedCards(kept, join.visiblePaperId), join.notableAfter ?? null);
}

/**
 * The cards after the reader in a new order. The cards through the deepest
 * anchor stay (splitFeedForReRank); `rank` orders the other cards after them
 * together with `added`, the related papers a like brings. The notable cards
 * keep their places, which also count the cards the reader met that left the
 * list, and other cards that do not fit before the last place follow it: a
 * place they pass has no notable card until the next page (joinNotablePage).
 * Null when there is no other card to order.
 */
export function reRankAfterReader(
  cards: Paper[],
  anchorPaperIds: Array<string | null>,
  rank: (others: Paper[], locked: Paper[]) => Paper[],
  added: Paper[] = [],
) {
  const { locked, queue } = splitFeedForReRank(cards, { anchorPaperIds });
  const addedIds = new Set(added.map(paper => paper.id));
  const pool = [...added, ...queue.filter(paper => !addedIds.has(paper.id))];
  const others = pool.filter(paper => !paper._notable);
  if (others.length === 0) return null;
  return { locked, queue: keepNotablePlaces(queue, rank(others, locked), pool.filter(paper => paper._notable)) };
}
