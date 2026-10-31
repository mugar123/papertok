/**
 * The privacy policy version the app announces. privacy.html promises that a
 * meaningful change updates its "Last updated" date and is announced in the
 * app to signed-in accounts created before the change took effect; the feed
 * shows PRIVACY_POLICY_CHANGE in a dialog (components/nudges/privacy-notice.tsx)
 * to each of them until they choose Got it for this PRIVACY_POLICY_VERSION.
 *
 * Whoever makes such a change to privacy.html sets the version to its new date
 * and rewrites the change to say the main changes since the previous version, in
 * at most three short bullets, the first leading with the change a reader would
 * most want to know. The dialog has to hold them on a phone's screen, so the full
 * list stays on the page. PRIVACY_POLICY_CHANGE_EVIDENCE below is rewritten with it.
 * Raising the date means re-reading `git diff <previous version>..HEAD --
 * privacy.html`, not only the commits you made: a merge brings in others'
 * edits to the page. privacy.test.ts fails while the version and the page's date
 * disagree. A second change on a day that already has a version takes a suffix
 * ('2026-10-25.2'), so readers who dismissed the first notice still hear of it.
 */
export const PRIVACY_POLICY_VERSION = '2026-10-28';

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
 * Whenever a change to the page needs announcing, bump the page's date,
 * PRIVACY_POLICY_VERSION and this instant together.
 *
 * The page's 28 October text, which also says where the kept feed order is
 * (#416), went live with #410: the Vercel status of its merge commit reports
 * success at 2026-10-28T08:32:06Z, so 08:35Z is a safe upper bound.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-10-28T08:35:00Z';

/** At most three short bullets, the dialog's whole message, in display order. */
export const PRIVACY_POLICY_CHANGE: readonly string[] = [
  'Usage analytics, run by PostHog, now connects your visits across days and records the papers you view, like or save, linked to your account when you sign in. Turn it off in Settings.',
  'Each request for more papers sends the server your interests, what you follow and the identifiers of up to 24 papers you liked, saved or read at length, to rank the page.',
  'The server keeps the order it ranked for you for up to 2 hours after your last page, near Frankfurt. Deleting your account does not remove it sooner.',
];

/**
 * Where PRIVACY_POLICY_CHANGE comes from, checked by privacy.test.ts: the
 * change it leads with, each clause beside the privacy.html sentence that
 * says it, and what it must not claim. Rewrite this with the summary.
 */
export const PRIVACY_POLICY_CHANGE_EVIDENCE: {
  lead: string;
  clauses: readonly (readonly [said: string, onPage: RegExp])[];
  unsaid: readonly (readonly [claim: RegExp, why: string])[];
} = {
  // An account from before 15 October read a page with Vercel Web Analytics and no PostHog.
  lead: 'PostHog',
  clauses: [
    ['run by PostHog', /PaperTok uses <strong>PostHog<\/strong>/],
    ['connects your visits across days', /PostHog keeps a random identifier in a first-party cookie and local storage on papertok\.app\. This identifier connects activity from the same browser across days/],
    ['records the papers you view, like or save', /Product events record the papers you view, open, like, save, highlight or annotate by their identifier/],
    ['linked to your account when you sign in', /When you sign in, PaperTok links that activity to your account identifier/],
    ['Turn it off in Settings', /turn off both services in <strong>Settings → Privacy<\/strong>/],
    // What a request for more papers carries, per the page's feed paragraph.
    ['Each request for more papers sends the server your interests', /Each request for more papers sends it your interests/],
    ['what you follow', /the subjects you removed, what you follow, the identifiers of up to 24 papers you liked, saved or read at length/],
    ['the identifiers of up to 24 papers you liked, saved or read at length', /the identifiers of up to 24 papers you liked, saved or read at length/],
    ['to rank the page', /They are used to choose and rank that page/],
    // What the server keeps of a ranked feed, and where (#347, #416).
    ['The server keeps the order it ranked for you', /the server keeps the order it ranked for you/],
    ['for up to 2 hours after your last page', /for up to 2 hours after your last page/],
    ['near Frankfurt', /placed near Frankfurt/],
    ['Deleting your account does not remove it sooner', /Deleting your account does not remove it sooner/],
  ],
  unsaid: [[/on by default/, 'anonymous analytics was already on by default on 20 October']],
};
