/**
 * The privacy policy version the app announces. privacy.html promises that a
 * meaningful change updates its "Last updated" date and is announced in the
 * app to signed-in accounts created before that date; NudgeHost shows
 * PRIVACY_POLICY_CHANGE to each of them until they dismiss this
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
export const PRIVACY_POLICY_VERSION = '2026-10-25';

export const PRIVACY_POLICY_CHANGE = 'Usage analytics is now on by default: PostHog keeps an identifier in this browser that connects your visits across days and links them to your account (turn it off in Settings), error reports go to PostHog, each request for more papers now sends the server your interests, what you follow, up to 24 papers you liked, saved or read at length, and a filter of the papers you viewed or were shown, to rank the page, and the server keeps your feed order for up to 2 hours and counts requests per account.';
