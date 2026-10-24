import type { Paper } from '../models/Paper.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reader's lean, from -1 (classic) to +1 (recent), after a like, a save or
 * a long read of `paper`, which moves it by `step`: toward recent for a paper
 * a week old or less, toward classic for one a year old or more. A notable
 * card's leave it as it is: the feed chose that card for its citations, and it
 * is years old by that choice.
 */
export function leanAfterEngaging(lean: number, paper: Pick<Paper, 'published' | '_notable'>, step: number, now = Date.now()) {
  if (paper._notable) return lean;
  const daysOld = (now - new Date(paper.published!).getTime()) / DAY_MS;
  if (daysOld <= 7) return Math.min(1, lean + step);
  if (daysOld >= 365) return Math.max(-1, lean - step);
  return lean;
}

/**
 * The order a page asks the corpus for. Relevance order is for a reader whose
 * views lean to older papers: the corpus ranks their page by likeness alone,
 * without the recency that separates near ties for everyone else.
 */
export function corpusOrder(lean: number) {
  return lean < -0.3 ? 'relevance' : 'recent';
}
