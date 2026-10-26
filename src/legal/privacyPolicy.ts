/**
 * The privacy policy version the app announces. privacy.html promises that a
 * meaningful change updates its "Last updated" date and is announced in the
 * app to signed-in accounts created before the change took effect; NudgeHost
 * shows PRIVACY_POLICY_CHANGE to each of them until they dismiss this
 * PRIVACY_POLICY_VERSION.
 *
 * Whoever makes such a change to privacy.html sets the version to its new date
 * and rewrites the change to say what changed since the previous version, in
 * one sentence that leads with the change a reader would most want to know.
 * Raising the date means re-reading `git diff <previous version>..HEAD --
 * privacy.html`, not only the commits you made: a merge brings in others'
 * edits to the page. privacy.test.ts fails while the version and the page's date
 * disagree. A second change on a day that already has a version takes a suffix
 * ('2026-10-25.2'), so readers who dismissed the first notice still hear of it.
 */
export const PRIVACY_POLICY_VERSION = '2026-10-26';

/**
 * When the announced policy text went live, as an ISO UTC instant on the day of
 * the version. An account created before it read an older policy and is told;
 * one created at or after it started under the announced text and is not. Keep
 * it at or AFTER the moment the announced policy text is live in production,
 * never before: an earlier instant skips the accounts created between it and
 * that moment, who read the old policy and are never told; a later one only
 * tells a few accounts that did not need it. Only the text's deploy counts, not
 * the deploy of this notice. When the text ships in the same PR, that moment is
 * not known yet: set a time after the merge, raise it before merging if the
 * merge slips, and lower it to the deployment's success time once it is live.
 * If the text goes live on a later UTC day, bump the page's date,
 * PRIVACY_POLICY_VERSION and this instant together.
 *
 * 2026-10-26T05:00Z: #363, the last announced privacy.html change, finished
 * deploying at 04:52:18Z (the Vercel status of its merge commit).
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-10-26T05:00:00Z';

export const PRIVACY_POLICY_CHANGE = 'Usage analytics is now on by default: PostHog keeps an identifier in this browser that connects your visits across days and links them to your account (turn it off in Settings), error reports go to PostHog, each request for more papers now sends the server your interests, what you follow, up to 24 papers you liked, saved or read at length, and a filter of the papers you viewed or were shown, to rank the page, and the server keeps your feed order for up to 2 hours and counts requests per account; emails are now sent by Resend, the server keeps a protected identifier derived from your IP address and the current minute to limit the PDF reader and public lookups, when the browser blocks the sign-in window the tab\'s session storage briefly holds the provider and the page to return to, and an error report for a failed feed load carries its reason, HTTP status and error code.';
