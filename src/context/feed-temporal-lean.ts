import type { TemporalSignal } from '../utils/interaction-profile.ts';
import { NOTABLE_EVERY } from '../utils/feed-enrichment.ts';
import { sampleBeta } from '../utils/recommendation-engine.ts';

/**
 * The order a page asks the corpus for. Relevance order is for a reader whose
 * views lean to older papers: the corpus ranks their page by likeness alone,
 * without the recency that separates near ties for everyone else. The lean is
 * the account's own (interaction-profile.ts, `temporal`).
 */
export function corpusOrder(lean: number) {
  return lean < -0.3 ? 'relevance' : 'recent';
}

// The fewest cards a notable place may follow (ENG-166, Pablo, 2026-10-27):
// at most one card in three is notable, at least one in NOTABLE_EVERY.
const NOTABLE_EVERY_MIN = 3;

/**
 * One notable place in how many cards, for one page (ENG-166). The share of
 * notable places is drawn from Beta(1 + notable, NOTABLE_EVERY - 1 + recent),
 * where `notable` and `recent` count the account's likes, saves and opened
 * PDFs of each kind of For You card: a weak prior centred on one in
 * NOTABLE_EVERY, which the account's engagement soon outweighs. Each page
 * draws again, so a share the counts make unlikely still comes up now and
 * then, as in exploration (pickExplorationCategories). The draw is kept
 * between one in NOTABLE_EVERY and one in NOTABLE_EVERY_MIN, so neither kind
 * of card leaves the feed.
 */
export function sampleNotableEvery({ notable, recent }: Pick<TemporalSignal, 'notable' | 'recent'>, random: () => number = Math.random) {
  const share = sampleBeta(1 + notable, NOTABLE_EVERY - 1 + recent, random);
  return Math.min(NOTABLE_EVERY, Math.max(NOTABLE_EVERY_MIN, Math.round(1 / share)));
}
