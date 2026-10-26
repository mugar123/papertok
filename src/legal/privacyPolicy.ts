/**
 * The privacy policy version the app announces. privacy.html promises that a
 * meaningful change updates its "Last updated" date and is announced in the
 * app to signed-in accounts created before the change took effect; NudgeHost
 * shows PRIVACY_POLICY_CHANGE to each of them until they dismiss this
 * PRIVACY_POLICY_VERSION.
 *
 * Whoever makes such a change to privacy.html sets the version to its new date
 * and rewrites the change to say the main changes since the previous version, in
 * one or two short sentences that lead with the change a reader would most want to
 * know. The panel sits over the card being read, so the full list stays on the page.
 * Raising the date means re-reading `git diff <previous version>..HEAD --
 * privacy.html`, not only the commits you made: a merge brings in others'
 * edits to the page. privacy.test.ts fails while the version and the page's date
 * disagree. A second change on a day that already has a version takes a suffix
 * ('2026-10-25.2'), so readers who dismissed the first notice still hear of it.
 */
export const PRIVACY_POLICY_VERSION = '2026-10-26';

/**
 * When the announced policy text went live, as an ISO UTC instant on or before
 * the day of the version (a page edited after midnight UTC is dated later than
 * its text went live). An account created before it read an older policy and is told;
 * one created at or after it started under the announced text and is not. Keep
 * it at or AFTER the moment the announced policy text is live in production,
 * never before: an earlier instant skips the accounts created between it and
 * that moment, who read the old policy and are never told; a later one only
 * tells a few accounts that did not need it. Only the text's deploy counts, not
 * the deploy of this notice. When the text ships in the same PR, that moment is
 * not known yet: set a time after the merge, raise it before merging if the
 * merge slips, and lower it to the deployment's success time once it is live.
 * Whenever the page's text changes again, bump the page's date,
 * PRIVACY_POLICY_VERSION and this instant together.
 *
 * 2026-10-26T05:00Z is an exception to that rule, kept on purpose. The summary
 * announces the PostHog analytics and the contents of a feed request, and both
 * were live before #363 finished deploying at 04:52:18Z (the Vercel status of
 * its merge commit), so 05:00Z is a safe upper bound. The page's 26 October
 * date came later with #385 (live about 11:01Z), and #330's figure-lookup
 * wording later still (about 19:24Z) without a date change. Neither changes
 * what an account is told, so accounts created after 05:00Z miss nothing they
 * needed. Do not copy this: a later change that the summary announces moves
 * the instant to when that text is live.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-10-26T05:00:00Z';

export const PRIVACY_POLICY_CHANGE = 'Usage analytics, run by PostHog, now connects your visits across days and records the papers you view, like or save, linked to your account when you sign in (turn it off in Settings). Each request for more papers now sends the server your interests, what you follow and the identifiers of up to 24 papers you liked, saved or read at length, to rank the page, and the policy lists the rest.';
