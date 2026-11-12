import { STORED_AUTHOR_CAP } from '../../utils/reading-library.ts';
import { LEGACY_SAVED_AUTHOR_CAP } from '../../utils/saved-paper-payload.ts';

/** How many names a byline writes out before it counts the rest. */
const SHOWN_NAMES = 3;

/**
 * The text of a list row's byline: its first names, and what follows them.
 *
 * A list holds stored copies, and a list of exactly as many names as a writer
 * keeps may have been cut there, so its count is a lower bound: it reads
 * "et al." rather than a number that may be false. Names some providers store
 * as "Last, First" are joined with semicolons, so two people do not read as
 * four.
 */
export function bylineText(names: string[]) {
  const shown = names.slice(0, SHOWN_NAMES);
  const rest = names.length - shown.length;
  const cut = names.length === LEGACY_SAVED_AUTHOR_CAP || names.length === STORED_AUTHOR_CAP;
  return {
    names: shown.join(shown.some(name => name.includes(',')) ? '; ' : ', '),
    more: rest > 0 ? (cut ? ' et al.' : ` +${rest}`) : null,
  };
}
