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
export const PRIVACY_POLICY_VERSION = '2026-11-03.2';

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
 * The page's 3 November text adds, since 28 October, the feed diagnostics
 * (#434), followed journals (#399), the per-account counts of highly cited and
 * recent papers and the lean to recent or older papers (#419), the MCP
 * server's request counters (#400), and what it says about this notice: how
 * Got it is stored and the Changes promise (ENG-14). Everything the summary
 * below announces was live before this instant. The Vercel status of each
 * merge commit behind a bullet reports success at: #434 2026-11-01T12:32:49Z,
 * #419 2026-11-03T06:34:59Z; the earlier bullets' text was live before
 * 28 October. #399 and #400 are left to the page (#400's counters, live at
 * 2026-11-03T06:41:47Z, concern only AI assistants calling the MCP server).
 * Re-check this list whenever a bullet changes. Only what the page says about
 * this notice ships with it. Pablo chose on 2026-11-03 to set this instant to
 * the time of the commit that set it, rounded up to the next quarter hour,
 * rather than after the merge.
 *
 * Version 2026-11-03.2 adds what the email subscription stores when the digest
 * is filled from the subjects a reader chose (ENG-163, #442). That page text
 * ships with #442, so unlike the bullets above it is not live at this instant:
 * an account created between this instant and #442's deploy is not told of
 * it. Following Pablo's choice above, this instant is the time of #442's
 * commit that set it, rounded up. The order the server keeps near Frankfurt
 * for up to 2 hours is left to the page to make room within three bullets.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-03T08:45:00Z';

/** At most three short bullets, the dialog's whole message, in display order. */
export const PRIVACY_POLICY_CHANGE: readonly string[] = [
  'PostHog analytics now connects your visits across days and records the papers you view, like or save and how the feed loads, linked to your account when you sign in. Turn it off in Settings.',
  'Your account now counts highly cited and recent papers you were shown, their likes, saves and PDF opens, and whether you lean to recent or older papers.',
  'To rank your feed, the server gets your interests, what you follow and up to 24 papers you liked, saved or read at length. Email updates, if on, store the subjects you chose.',
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
    ['PostHog analytics', /PaperTok uses <strong>PostHog<\/strong>/],
    ['connects your visits across days', /PostHog keeps a random identifier in a first-party cookie and local storage on papertok\.app\. This identifier connects activity from the same browser across days/],
    ['records the papers you view, like or save', /Product events record the papers you view, open, like, save, highlight or annotate by their identifier/],
    // The feed diagnostics (#434).
    ['how the feed loads', /Feed diagnostics record load starts, duration, result, initial loads versus refreshes or additional pages, automatic retries/],
    ['linked to your account when you sign in', /When you sign in, PaperTok links that activity to your account identifier/],
    ['Turn it off in Settings', /turn off both services in <strong>Settings → Privacy<\/strong>/],
    // What the account keeps to set the share of highly cited papers and the lean (#419).
    ['Your account now counts highly cited and recent papers you were shown', /Your account also counts, for the highly cited papers and for the recent papers in your feed, how many you were shown/],
    ['their likes, saves and PDF opens', /how many likes, saves and PDF opens they got/],
    ['whether you lean to recent or older papers', /a number for how much you lean to recent or older papers/],
    // What a request for more papers carries, per the page's feed paragraph.
    ['To rank your feed', /They are used to choose and rank that page/],
    ['the server gets your interests', /Each request for more papers sends it your interests/],
    ['what you follow', /the subjects you removed, what you follow, the identifiers of up to 24 papers you liked, saved or read at length/],
    ['up to 24 papers you liked, saved or read at length', /the identifiers of up to 24 papers you liked, saved or read at length/],
    // What the email subscription keeps when the digest is filled from chosen subjects (ENG-163, #442).
    ['Email updates', /<h2>Email updates<\/h2>/],
    ['if on', /If you turn them on, PaperTok emails you/],
    ['store the subjects you chose', /it stores your email address, your sending preferences, what you follow, the identifiers of the subjects you chose and an unsubscribe identifier in <strong>Cloudflare Workers KV<\/strong>/],
  ],
  unsaid: [[/on by default/, 'anonymous analytics was already on by default on 20 October']],
};
