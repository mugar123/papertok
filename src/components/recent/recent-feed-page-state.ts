/**
 * What the page shows instead of cards. Null while it has cards or is still
 * loading. A reader with no topics asks for nothing, so that is said even
 * while something else loads; a failure with no cards is the container's
 * error state. A list that stopped asking by itself while it has more
 * (MAX_EMPTY_AUTO_PAGES) is not caught up: it offers its older papers.
 */
export function recentEmptyKind({ hasTopics, hasPapers, hasMore, loading, error }: {
  hasTopics: boolean;
  hasPapers: boolean;
  hasMore: boolean;
  loading: boolean;
  error: unknown;
}): 'no-topics' | 'more' | 'caught-up' | 'error' | null {
  if (!hasTopics) return 'no-topics';
  if (hasPapers) return null;
  if (error) return 'error';
  if (loading) return null;
  return hasMore ? 'more' : 'caught-up';
}

/**
 * A load the reader started from the page's empty state: Check again
 * (`asked`) or Show older papers (`asked-older`) while it runs, `none-new` or
 * `none-older` once it came back with nothing to show, `idle` otherwise.
 */
export type RecentCheck = 'idle' | 'asked' | 'none-new' | 'asked-older' | 'none-older';

/**
 * Where a check stands after a render. `busy` says a load runs or is due. A
 * check is over when papers arrive or its load ends: with nothing to show it
 * found nothing new, and a failure is the error state's to say. A load the
 * buttons did not start (a press on the tab) clears what the last check found.
 */
export function settleRecentCheck(check: RecentCheck, { busy, hasPapers, error }: { busy: boolean; hasPapers: boolean; error: unknown }): RecentCheck {
  if (hasPapers) return 'idle';
  if (check === 'asked' || check === 'asked-older') {
    if (busy) return check;
    if (error) return 'idle';
    return check === 'asked' ? 'none-new' : 'none-older';
  }
  return (check === 'none-new' || check === 'none-older') && busy ? 'idle' : check;
}

const CHECK_STATUS: Record<RecentCheck, string> = {
  idle: '',
  asked: 'Checking for new papers…',
  'none-new': 'No new papers yet.',
  'asked-older': 'Loading older papers…',
  'none-older': 'Those were not new to you either.',
};

/** What the empty state adds to its sentence about the check. */
export function recentCheckStatus(check: RecentCheck): string {
  return CHECK_STATUS[check];
}
