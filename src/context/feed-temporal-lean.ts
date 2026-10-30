import type { Paper } from '../models/paper.ts';
import type { InteractionEvent, TemporalSignal } from '../utils/interaction-profile.ts';
import { areaKeyForPaper } from '../utils/area-accent.ts';
import { NOTABLE_EVERY } from '../utils/feed-enrichment.ts';
import { paperAffinitySignals, sampleGamma } from '../utils/recommendation-engine.ts';

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
 * `analyticsSurface`): only For You's cards report 'feed'. A card the list no
 * longer holds, such as one the reader dismissed or a report that lands after
 * a refresh, keeps its own mark: only the Worker sets `_notable`, so a card
 * without it is recent. Undefined for any other event, such as a Following
 * card, a library row, a search result or a paper opened from a card's
 * Connections, even when the For You list holds the same paper: it counts
 * toward neither kind.
 */
export function forYouCardNotable(cards: ReadonlyArray<Pick<Paper, 'id' | '_notable'>>, paper: Pick<Paper, 'id' | '_notable'>, surface: string | undefined) {
  if (surface !== 'feed') return undefined;
  const card = cards.find(listed => listed.id === paper.id);
  if (card) return card._notable === true;
  return paper._notable === true;
}

/**
 * `event` as the feed records it for `paper`: with the paper's OpenAlex
 * concepts and authors, its area and the date a like, a save or a long read
 * moves the lean by (leanAfterEngaging). A notable card lends no date, so it
 * leaves the lean as it was wherever the reader engages with it, the list
 * picker included, even when the event does not count it as a For You card:
 * it is years old because the feed chose it. A copy of the same paper from
 * elsewhere, such as a search result, carries no `_notable`, and its date
 * moves the lean as any paper's does.
 */
export function profileEvent(event: InteractionEvent, paper: Partial<Paper> | null | undefined): InteractionEvent {
  if (!paper) return event;
  return { published: paper._notable === true ? null : paper.published, ...event, ...paperAffinitySignals(paper), area: areaKeyForPaper(paper) };
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
