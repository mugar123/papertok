import type { Paper } from '../models/paper.ts';

/** What the account's "Not interested" promises, under the action in a card's menu. */
export const ACCOUNT_DISMISSAL_HINT = 'See fewer papers like this';

/** What "Not interested" does on a feed, how Undo takes it back, the confirmation it shows and the hint under it. */
export interface Dismissal {
  hide: (paper: Paper) => void;
  /** `atIndex` is where the account's feed puts the paper back; a source's own dismissal ignores it. */
  restore: (paper: Paper, atIndex: number | null) => void;
  label: string;
  hint: string;
}

/**
 * A source that brings its own dismissal (a custom feed) removes the paper
 * from that feed only; every other feed tells the account, which teaches
 * the recommendations.
 */
export function dismissalFor(
  source: { dismissal?: { hide: (paper: Paper) => void; restore: (paper: Paper) => void; label: string; hint: string } } | null,
  account: Pick<Dismissal, 'hide' | 'restore'>,
): Dismissal {
  const own = source?.dismissal;
  if (own) return { hide: own.hide, restore: paper => own.restore(paper), label: own.label, hint: own.hint };
  return { hide: account.hide, restore: account.restore, label: 'Marked as not interested', hint: ACCOUNT_DISMISSAL_HINT };
}
