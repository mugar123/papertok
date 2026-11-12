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
export const PRIVACY_POLICY_VERSION = '2026-11-12';

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
 * author, topic or keyword search put in a feed joins the list of things the
 * catalogue collects papers for, as a follow does; and the three usage events:
 * creating or opening a feed records its order, creating one also the counts of
 * what it holds, deleting one only that it happened, and none records its
 * name. The text ships with the frontend pull request of custom feeds
 * (ENG-197); the Worker half is #476. This instant follows the rule above: it
 * stands after that merge, at the last moment the version's day allows. If the
 * merge falls after it, move the page's "Last updated" date,
 * PRIVACY_POLICY_VERSION and this instant to the merge day before merging; once
 * Vercel reports the merge live, lower this instant to that success time.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-12T23:59:59Z';

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
  "Feeds you create are kept with your account, and their topics, authors and keywords are sent to the server to fetch their papers.",
  "Papers you remove from a feed are kept in your browser and sent with that feed's requests, so it leaves them out.",
  "Usage analytics also records when you create, open or delete a feed, never its name or what is in it. Its events also name your browser and system versions.",
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
  // The changes since 7 November: custom feeds (ENG-197, Worker half #476), that
  // is what a feed keeps in the account, what its requests send, the removed
  // papers the browser keeps and sends, and the usage events about feeds; and
  // the browser and system versions analytics events name (#457). #464 only
  // added the page's text about this notice and its record, which this
  // notice does not announce.
  lead: 'Feeds you create',
  clauses: [
    ['Feeds you create', /<td>Feeds you create: each feed's name and the areas, topics, authors and keywords you put in it<\/td>/],
    ['kept with your account', /They are kept with your account and deleted with it/],
    ['their topics, authors and keywords are sent to the server', /A request for a page of one of your own feeds sends instead that feed's areas, categories, research topics, authors and keywords/],
    ['Papers you remove from a feed are kept in your browser', /This browser also keeps, for each of your own feeds, the latest 200 papers you removed from it/],
    ["sent with that feed's requests, so it leaves them out", /these are sent to the server with each request for that feed, so the feed leaves them out/],
    ['Usage analytics', /Usage analytics is enabled by default/],
    ['create, open or delete a feed', /Creating or opening one of your feeds records the order it uses; creating one also records how many areas or topics, authors and keywords it holds\. Deleting one records only that it happened\./],
    ['never its name or what is in it', /No event records a feed's name or what is in it\./],
    ['your browser and system versions', /Events include the browser and its version, the operating system and its version/],
  ],
  unsaid: [
    [/(?<!never )\b(its|a feed's|the feed's) name\b/i, "no event records a feed's name; only the account keeps it"],
    [/remove\w*[^.]*(kept|stored) (in|with) your account/i, 'the papers removed from a feed stay in the browser, not the account'],
    [/full user agent/i, 'the browser label never holds the full user agent'],
    [/\bsince \d{1,2} [a-z]+/i, 'the summary says only what changed since the previous version'],
  ],
};
