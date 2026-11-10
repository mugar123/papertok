/**
 * What the page shows instead of cards. Null while it has cards or is still
 * loading. A reader with no topics asks for nothing, so that is said even
 * while something else loads; a failure with no cards is the container's
 * error state.
 */
export function recentEmptyKind({ hasTopics, hasPapers, loading, error }: {
  hasTopics: boolean;
  hasPapers: boolean;
  loading: boolean;
  error: unknown;
}): 'no-topics' | 'caught-up' | 'error' | null {
  if (!hasTopics) return 'no-topics';
  if (hasPapers) return null;
  if (error) return 'error';
  return loading ? null : 'caught-up';
}

/**
 * Check again on the caught-up state: `asked` while the load it started
 * runs, `none-new` once that load came back with nothing to show, `idle`
 * otherwise.
 */
export type RecentCheck = 'idle' | 'asked' | 'none-new';

/**
 * Where Check again stands after a render. `busy` says a load runs or is
 * due. A check is over when papers arrive or its load ends: with nothing to
 * show it found nothing new, and a failure is the error state's to say. A
 * load the button did not start (a press on the tab) clears what the last
 * check found.
 */
export function settleRecentCheck(check: RecentCheck, { busy, hasPapers, error }: { busy: boolean; hasPapers: boolean; error: unknown }): RecentCheck {
  if (hasPapers) return 'idle';
  if (check === 'asked') {
    if (busy) return 'asked';
    return error ? 'idle' : 'none-new';
  }
  return check === 'none-new' && busy ? 'idle' : check;
}

/** What the caught-up state adds to its sentence about Check again. */
export function recentCheckStatus(check: RecentCheck): string {
  if (check === 'asked') return 'Checking for new papers…';
  return check === 'none-new' ? 'No new papers yet.' : '';
}
