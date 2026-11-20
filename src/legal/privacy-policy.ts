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
export const PRIVACY_POLICY_VERSION = '2026-11-20.8';

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
 * Version 2026-11-14 withdraws a sentence of 2026-11-12: a request for one of
 * the reader's own feeds sent no filter of the papers they viewed, and a
 * refresh of the feed now sends one, so the feed starts with the papers they
 * have not seen (Nicolás chose the announcement on 2026-11-14). It also
 * announces the metadata of the papers in the reader's lists and favorites
 * that the browser keeps since #502. The page's mentions of journals in a
 * feed (#493) and of the Most recent tab (#478) joined the 2026-11-12 text
 * without a version and are not announced. The text ships with the pull
 * request that makes a custom feed's refresh skip seen papers. This instant
 * follows the rule above: it stands after that merge, at the last moment the
 * version's day allows. If the merge falls after it, move the page's "Last
 * updated" date, PRIVACY_POLICY_VERSION and this instant to the merge day
 * before merging; once Vercel reports the merge live, lower this instant to
 * that success time.
 *
 * Version 2026-11-15 adds Zotero: the encrypted key and the item and note keys
 * kept while a reader has Zotero connected, what a send gives Zotero, and the
 * usage event that records only whether a send worked. It takes its own
 * version because 2026-11-14 went live with the feed refresh notice. This
 * instant follows the rule above for a text that ships with its own pull
 * request.
 *
 * Version 2026-11-20 adds ORCID: the iD and the record's name kept while a
 * reader has ORCID connected, the access token that is not stored, and My
 * profile, shown only to the reader, whose works the browser loads from
 * ORCID's public API, with the works OpenAlex links to the iD and the
 * identifiers of those the reader marks as theirs or not. It ships with the
 * pull request that adds the ORCID routes and My profile, and this instant
 * follows the rule above for such a text: it stands at the end of the day
 * the merge is planned for. If the merge falls after it, move the page's
 * "Last updated" date, PRIVACY_POLICY_VERSION and this instant to the merge
 * day before merging, and lower it to the deployment's success time once it
 * is live.
 *
 * Version 2026-11-20.2 adds the reading level, broad areas of interest and
 * optional role linked to an account in survey analytics (#526). Since the
 * first 20 November version, My profile also lists citing papers and frequent
 * coauthors (#527). The survey text ships with this PR, so its provisional
 * cutoff is the last whole second of the planned merge day. If the merge slips
 * past the cutoff, move the date, version and cutoff to the merge day.
 * Set the cutoff to the deployment's success time once the text is live.
 *
 * Version 2026-11-20.4 adds weekly save contributions from verified-email
 * accounts, the default-on setting and how readers can exclude future saves.
 * The text ships with #531. Use the end of the planned merge day until the
 * deployment succeeds, then use its success time. If the merge slips to a
 * later UTC day, update the page date, version and cutoff before merging.
 *
 * Version 2026-11-20.5 adds Anthropic and its processing regions. The same
 * provisional cutoff applies until the page ships with #532.
 *
 * Version 2026-11-20.8 adds the optional use of ORCID and OpenAlex to find
 * papers that cite a reader's work for the weekly email (#529). It lands after
 * #534 and #535, so recheck its version, summary and cutoff once they merge.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-20T23:59:59Z';

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
  "Anthropic's Claude explains and rewrites papers and may process paper text outside the EU.",
  'With a verified email, saves count by default and link your account to each saved paper once per UTC week. Omit future saves in Settings → Privacy.',
  'With usage analytics on, survey events link your account to your reading level and broad interests, and submissions record your optional role. If you connect ORCID, the weekly email and My profile list papers citing your work, and your iD goes to OpenAlex.',
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
  lead: "Anthropic's Claude",
  clauses: [
    ["Anthropic's Claude explains and rewrites papers", /Paper explanations and rewrites are generated by a Claude language model, run by Anthropic/],
    ['may process paper text outside the EU', /Anthropic may process the request in any region it serves, including outside the European Union/],
    ['With a verified email, saves count by default', /With a verified email, your saves count by default/],
    ['link your account to each saved paper once per UTC week', /PaperTok links your account to each paper you save once per UTC week/],
    ['Omit future saves in Settings → Privacy', /Turn this off in Settings → Privacy to exclude future saves/],
    ['With usage analytics on, survey events link your account', /With usage analytics on, PaperTok links survey events to your account/],
    ['your reading level and broad interests', /events include your reading level and broad areas of interest, such as Physics, when available/],
    ['submissions record your optional role', /Submitting the survey records your answers, including your role if you chose one/],
    ['the weekly email and My profile list papers citing your work', /the weekly email can also list new papers that cite your work/],
    ['your iD goes to OpenAlex', /PaperTok sends your iD and the OpenAlex work identifiers it checks to OpenAlex/],
    ['My profile', /papers from the last 12 months that cite your publications/],
  ],
  unsaid: [
    [/anonymous/i, 'survey events are linked to the signed-in account'],
    [/required role/i, 'readers can skip the role question'],
    [/authors can see|published totals/i, 'this release only collects contributions'],
  ],
};
