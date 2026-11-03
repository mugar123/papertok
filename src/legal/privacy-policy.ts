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
 * ('2026-10-25.2'), so readers who chose Got it on the first notice still hear of it.
 */
export const PRIVACY_POLICY_VERSION = '2026-11-03';

/**
 * When the announced policy text went live, as an ISO UTC instant on or before
 * the day of the version (a page edited after midnight UTC is dated later than
 * its text went live). An account created before it read an older policy and is told;
 * one created at or after it started under the announced text and is not. Keep
 * it at or AFTER the moment the page text behind everything the summary
 * announces is live in production, never before: an earlier instant skips the
 * accounts created between it and that moment, who read the old policy and are
 * never told; a later one only tells a few accounts that did not need it. Page
 * text that only describes this notice does not count, nor does the notice's
 * own deploy. When the announced text ships in the same PR, that moment is
 * not known yet: set a time after the merge, raise it before merging if the
 * merge slips, and lower it to the deployment's success time once it is live.
 * Whenever a change to the page needs announcing, bump the page's date,
 * PRIVACY_POLICY_VERSION and this instant together.
 *
 * The page's 3 November text adds followed journals (#399), the feed
 * diagnostics (#434) and what it says about this notice: how Got it is stored
 * and the Changes promise (ENG-14). Everything the summary below announces was
 * live before this instant: the Vercel status of #434's merge commit reports
 * success at 2026-11-01T12:32:49Z, and #399's at 2026-11-03T00:15:25Z. Only
 * what the page says about this notice ships with it. Pablo chose on 2026-11-03
 * to set this instant to the time of the commit that set it, rounded up to the
 * next quarter hour, rather than after the merge. An account created between
 * this instant and the deploy is not told: it signed up under a page, still
 * dated 28 October, that already said everything the summary announces.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-03T06:15:00Z';

/** At most three short bullets, the dialog's whole message, in display order. */
export const PRIVACY_POLICY_CHANGE: readonly string[] = [
  'Usage analytics, run by PostHog, now connects your visits across days and records the papers you view, like or save and how the feed loads, linked to your account when you sign in. Turn it off in Settings.',
  'Each request for more papers sends the server your interests, what you follow (journals too) and identifiers of up to 24 papers you liked, saved or read at length, to rank the page.',
  'The server keeps the order it ranked for you near Frankfurt for up to 2 hours after your last page, even if you delete your account.',
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
    // The feed diagnostics (#434).
    ['how the feed loads', /Feed diagnostics record load starts, duration, result, initial loads versus refreshes or additional pages, automatic retries/],
    ['linked to your account when you sign in', /When you sign in, PaperTok links that activity to your account identifier/],
    ['Turn it off in Settings', /turn off both services in <strong>Settings → Privacy<\/strong>/],
    // What a request for more papers carries, per the page's feed paragraph.
    ['Each request for more papers sends the server your interests', /Each request for more papers sends it your interests/],
    ['what you follow', /the subjects you removed, what you follow, the identifiers of up to 24 papers you liked, saved or read at length/],
    // Followed journals build the feed like other follows (#399).
    ['(journals too)', /Authors, institutions, topics and journals you follow<\/td> <td>Your use of the app<\/td> <td>Building your feed/],
    ['identifiers of up to 24 papers you liked, saved or read at length', /the identifiers of up to 24 papers you liked, saved or read at length/],
    ['to rank the page', /They are used to choose and rank that page/],
    // What the server keeps of a ranked feed, and where (#347, #416).
    ['The server keeps the order it ranked for you', /the server keeps the order it ranked for you/],
    ['near Frankfurt', /placed near Frankfurt/],
    ['for up to 2 hours after your last page', /for up to 2 hours after your last page/],
    ['even if you delete your account', /Deleting your account does not remove it sooner; it expires on its own/],
  ],
  unsaid: [[/on by default/, 'anonymous analytics was already on by default on 20 October']],
};
