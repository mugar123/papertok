import type { EntitySearch, SearchIssue, SearchScope, SearchSnapshot } from '../../services/entitySearchService.ts';
import { isOpenAlexBudgetRefusal, isOpenAlexRateLimitError } from '../../services/openAlexClient.ts';
import { SECTION_SOURCES, describeSearchOutage } from '../../utils/searchOutage.ts';

/**
 * The search page's search of the current query. Aborting its controller is
 * what ends it. `scope` is the one on screen, which the page changes when the
 * reader opens another; the search answers each scope it was asked for, and
 * only the answer for this one paints.
 */
export type SearchRun = { controller: AbortController; search: EntitySearch; scope: SearchScope };

/**
 * Whether the answer the run settled with for `scope` may paint: only while
 * the run is current and `scope` is still the one on screen. The answer for a
 * scope the reader left still settles, and would paint the new scope's
 * sections empty, and announce that, before they are in.
 */
export function scopeAnswerPaints(run: SearchRun, scope: SearchScope) {
  return !run.controller.signal.aborted && run.scope === scope;
}

/**
 * Opens `scope` on the running search. A scope the search was not asked for
 * is asked for now, so a reader who stays on Papers never pays for the author
 * search; `waiting` lets the skeleton cover the wait. A scope already
 * answered paints with the scope change, the notice included, so the new
 * scope never renders the previous paint's sections.
 */
export function openSearchScope(run: SearchRun | null, scope: SearchScope, paint: (snapshot: SearchSnapshot) => void, waiting: () => void) {
  if (!run || run.controller.signal.aborted) return;
  run.scope = scope;
  if (run.search.settled(scope)) {
    paint(run.search.snapshot());
    return;
  }
  waiting();
  void run.search.ask(scope).then(snapshot => {
    if (scopeAnswerPaints(run, scope)) paint(snapshot);
  });
}

/**
 * The notice for an answer's failed sections. Only OpenAlex's own sections
 * can testify about OpenAlex: a 429 from OpenAIRE also satisfies
 * `isOpenAlexRateLimitError`, which walks the cause chain looking for that
 * status. OpenAlex refusing the key is an outage with a wait; the Worker
 * pausing searches for the day's budget is not, and has no wait worth
 * counting.
 *
 * Both sources of the wait, latest end wins: the client zeroes
 * `rateLimitedUntil` as soon as any request succeeds, so `health` can read 0
 * while the error that failed still carries what OpenAlex said. That wait
 * counts from the failure, not from this paint: opening a scope repaints the
 * same answer.
 */
export function searchPageIssue(issues: SearchIssue[], health: { rateLimited: boolean; retryAfterMs: number }, now: number) {
  const failedSections = issues.map(issue => issue.section);
  const openAlexIssues = issues.filter(issue => SECTION_SOURCES[issue.section] === 'openalex');
  const keyRefused = (error: unknown) => isOpenAlexRateLimitError(error) && !isOpenAlexBudgetRefusal(error);
  const rateLimited = health.rateLimited
    || openAlexIssues.some(issue => keyRefused(issue.error));
  const budgetPaused = openAlexIssues.some(issue => isOpenAlexBudgetRefusal(issue.error));
  const retryAtMs = Math.max(
    now + (health.retryAfterMs || 0),
    ...openAlexIssues.map(issue => (
      keyRefused(issue.error)
        ? issue.failedAtMs + ((issue.error as { retryAfterMs?: number } | null)?.retryAfterMs || 0)
        : 0
    )),
  );
  return describeSearchOutage({ sections: failedSections, rateLimited, budgetPaused, retryAfterMs: retryAtMs - now, now });
}
