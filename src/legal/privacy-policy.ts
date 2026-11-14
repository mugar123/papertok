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
export const PRIVACY_POLICY_VERSION = '2026-11-14';

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
 * Version 2026-11-07 adds what the email subscription stores when the digest
 * is filled from the subjects a reader chose, and that it is kept in Workers KV
 * or, once moved, a Durable Object of the account (ENG-163, #442), and what
 * usage analytics records when a paper opens in the app's viewer (#458). The
 * email wording holds for both deploy phases, so phase 2 needs no new notice.
 * Both texts ship with #442, which merges before #458 so that no build sends
 * viewer events before this notice. This instant follows the rule above: it
 * stands after #442's merge, at the last moment the version's day allows. If the merge
 * falls after it, move the page's "Last updated" date, PRIVACY_POLICY_VERSION
 * and this instant to the merge day before merging; once Vercel reports the
 * merge live, lower this instant to that success time.
 *
 * Version 2026-11-12 adds custom feeds: the feeds a reader creates, kept with
 * the account; what a request for one of those feeds sends; the papers removed
 * from a feed, kept in the browser and sent with that feed's requests; that an
 * author, topic, journal or keyword search put in a feed joins the list of
 * things the catalogue collects papers for, as a follow does (journals joined
 * the same day, without a version of their own); and the three usage events:
 * creating or opening a feed records its order, creating one also the counts of
 * what it holds, deleting one only that it happened, and none records its
 * name. The text ships with the frontend pull request of custom feeds
 * (ENG-197); the Worker half is #476. This instant follows the rule above: it
 * stands after that merge, at the last moment the version's day allows. If the
 * merge falls after it, move the page's "Last updated" date,
 * PRIVACY_POLICY_VERSION and this instant to the merge day before merging; once
 * Vercel reports the merge live, lower this instant to that success time.
 *
 * Version 2026-11-14 adds Zotero: the encrypted key and the item and note keys
 * kept while a reader has Zotero connected, what a send gives Zotero, and the
 * usage event that records only whether a send worked. This instant follows
 * the rule above for a text that ships with its own pull request.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-14T23:59:59Z';

/**
 * The version every account counts as already shown, whatever this browser or
 * the account has recorded. The 2026-11-07 notice went live at 08:04Z that day
 * when only each browser remembered it, so a reader who had seen it would have
 * seen it again on every new browser or device. Pablo decided on 2026-11-07
 * (ENG-196) that no account is shown it again, including one that never saw
 * it, and that only later versions are remembered in the account. Leave this
 * at 2026-11-07: raising it would skip a later version's notice for every
 * account, and nothing is written to accounts for it.
 */
export const PRIVACY_NOTICE_BASELINE_VERSION = '2026-11-07';

/** At most three short bullets, the dialog's whole message, in display order. */
export const PRIVACY_POLICY_CHANGE: readonly string[] = [
  "If you connect Zotero, an encrypted key to your Zotero library is kept with your account until you disconnect.",
  "Sending a paper gives Zotero its citation and the highlights and notes you made on it, never the AI's highlights.",
  "Usage analytics records only whether a send to Zotero worked, not which paper.",
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
  // The changes since 12 November: connecting Zotero, what a send gives it,
  // and the usage event about sends.
  lead: 'If you connect Zotero',
  clauses: [
    ['If you connect Zotero', /<td>If you connect Zotero: an encrypted access key to your Zotero library/],
    ['kept with your account until you disconnect', /Disconnecting in <strong>Settings → Profile<\/strong> deletes the key/],
    ['Sending a paper gives Zotero its citation', /Each send gives Zotero the paper's citation/],
    ['the highlights and notes you made on it', /the highlights and notes you made on that paper/],
    ["never the AI's highlights", /Highlights made by the AI are not sent\./],
    ['Usage analytics', /Usage analytics is enabled by default/],
    ['only whether a send to Zotero worked, not which paper', /Sending a paper to Zotero records only whether it was sent, not which paper\./],
  ],
  unsaid: [
    [/group/i, 'only the personal library is reached'],
    [/\bPDF\b|full text/i, "Zotero receives the citation and the reader's own highlights, never the paper's file"],
    [/\bsince \d{1,2} [a-z]+/i, 'the summary says only what changed since the previous version'],
  ],
};
