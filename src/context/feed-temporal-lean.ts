import type { Paper } from '../models/paper.ts';
import type { TemporalSignal } from '../utils/interaction-profile.ts';
import { NOTABLE_EVERY } from '../utils/feed-enrichment.ts';
import { sampleGamma } from '../utils/recommendation-engine.ts';

/**
 * The order a page asks the corpus for. Relevance order is for a reader whose
 * views lean to older papers: the corpus ranks their page by likeness alone,
 * without the recency that separates near ties for everyone else. The lean is
 * the account's own (interaction-profile.ts, `temporal`), or a guest's for the
 * session.
 */
export function corpusOrder(lean: number) {
  return lean < -0.3 ? 'relevance' : 'recent';
}

/**
 * Whether `paper` is a notable or another card of the For You list `cards`,
 * for a view, a skip, a like, a save or an opened PDF to count toward its kind
 * (sampleNotableEvery). `surface` is the card's own (PaperCard's
 * `analyticsSurface`): only For You's cards report 'feed'. A notable card the
 * list no longer holds, such as one the reader dismissed, is still notable.
 * Undefined for any other event, such as a Following card, a library row, a
 * search result or a paper opened from a card's Connections, even when the For
 * You list holds the same paper: it counts toward neither kind.
 */
export function forYouCardNotable(cards: ReadonlyArray<Pick<Paper, 'id' | '_notable'>>, paper: Pick<Paper, 'id' | '_notable'>, surface: string | undefined) {
  if (surface !== 'feed') return undefined;
  const card = cards.find(listed => listed.id === paper.id);
  if (card) return card._notable === true;
  return paper._notable === true ? true : undefined;
}

// The fewest cards a notable place may follow (ENG-166, Pablo, 2026-10-27):
// at most one card in three is notable, at least one in NOTABLE_EVERY.
const NOTABLE_EVERY_MIN = 3;
// The prior's weight, in engagements of each kind. Five gives a new account
// about one notable place in eleven cards on average (ENG-166, decision 7),
// and a few dozen cards of each kind outweigh it.
const PRIOR_ENGAGEMENTS = 5;

/**
 * One notable place in how many cards, for one page (ENG-166). Each kind of
 * For You card has an engagement rate per card shown: the likes, saves and
 * opened PDFs it got over the times it was shown. Each page draws a rate for
 * each kind from its Gamma posterior, whose prior is the account's rate over
 * both kinds, so a kind shown less is not taken for one liked less. Equal
 * rates give today's one place in NOTABLE_EVERY; a notable rate k times the
 * recent one gives k notable cards for every NOTABLE_EVERY - 1 others. Each
 * page draws again, so a share the counts make unlikely still comes up now
 * and then, as in exploration (pickExplorationCategories). The draw is kept
 * between one in NOTABLE_EVERY and one in NOTABLE_EVERY_MIN, so neither kind
 * of card leaves the feed.
 */
export function sampleNotableEvery({ notable, recent }: Pick<TemporalSignal, 'notable' | 'recent'>, random: () => number = Math.random) {
  const rate = (notable.engaged + recent.engaged + 1) / (notable.shown + recent.shown + 10);
  const priorShown = PRIOR_ENGAGEMENTS / rate;
  const draw = ({ shown, engaged }: TemporalSignal['notable']) => sampleGamma(PRIOR_ENGAGEMENTS + engaged, random) / (priorShown + shown);
  const odds = draw(notable) / draw(recent) / (NOTABLE_EVERY - 1);
  return Math.min(NOTABLE_EVERY, Math.max(NOTABLE_EVERY_MIN, Math.round((1 + odds) / odds)));
}
