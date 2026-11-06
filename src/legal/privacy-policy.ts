/**
 * The privacy policy version the app announces. privacy.html promises that a
 * meaningful change updates its "Last updated" date and is announced in the
 * app to signed-in accounts created before the change took effect; the feed
 * shows PRIVACY_POLICY_CHANGE in a dialog (components/nudges/privacy-notice.tsx)
 * to each of them once for this PRIVACY_POLICY_VERSION.
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
 * ('2026-10-25.2'), so readers who were shown the first notice still hear of it.
 */
export const PRIVACY_POLICY_VERSION = '2026-11-06';

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
 * The page's 5 November text adds, since 3 November, the in-app reader
 * (#424): a paper's text comes through PaperTok's server, while its figures,
 * and a PDF shown on a computer, load straight from the repository, which
 * receives the reader's IP address; and the Wikidata and Wikipedia lookups the
 * explorer's pages (already on main, undescribed until now) and the reader's
 * author preview make from the browser, which Asier chose on 2026-11-05 to
 * describe rather than route through the Worker.
 *
 * Version 2026-11-06 adds what the email subscription stores when the digest
 * is filled from the subjects a reader chose, and that it is kept in a Durable
 * Object of the account (ENG-163, #442). That page text
 * ships with #442, so this instant follows the rule above: it stands after
 * #442's merge, at the last moment the version's day allows. If the merge
 * falls after it, move the page's "Last updated" date, PRIVACY_POLICY_VERSION
 * and this instant to the merge day before merging; once Vercel reports the
 * merge live, lower this instant to that success time.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-06T23:59:59Z';

/** At most three short bullets, the dialog's whole message, in display order. */
export const PRIVACY_POLICY_CHANGE: readonly string[] = [
  "Email updates, if on, also store the subjects you chose, and keep your subscription in a Cloudflare Durable Object of your account.",
  "Since 5 November, in the reader, a paper's figures, and a PDF shown on a computer, load directly from the repository that hosts it, which receives your IP address.",
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
  // The only change since 5 November: what the email subscription keeps when
  // the digest is filled from chosen subjects, and where (ENG-163, #442).
  lead: 'Email updates',
  clauses: [
    ['Email updates', /<h2>Email updates<\/h2>/],
    ['if on', /If you turn them on, PaperTok emails you/],
    ['store the subjects you chose', /the identifiers of the subjects you chose/],
    ['in a Cloudflare Durable Object of your account', /in a <strong>Cloudflare Durable Object<\/strong> of your account/],
    // Kept from 5 November for an account that has not opened the app since:
    // it read that repositories never receive its IP address.
    ["a paper's figures, and a PDF shown on a computer, load directly from the repository that hosts it", /your browser loads each figure, and a PDF shown in the reader on a computer, directly from the repository that hosts it/],
    ['which receives your IP address', /which receives your IP address as with any image on the web/],
  ],
  unsaid: [[/(stor|keep)\w* (what|which|the papers) you (read|open)/i, 'the reader keeps nothing new about the reader']],
};
