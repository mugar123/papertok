/**
 * The version shown when a signed-in account is owed a notice
 * (see utils/nudges.ts). Until 0.4, later edits update the policy page silently
 * for accounts with a notice record at or after PRIVACY_NOTICE_BASELINE_VERSION.
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
 * ('2026-10-25.2'), so the account record identifies the text behind the notice.
 */
export const PRIVACY_POLICY_VERSION = '2026-11-21';

/**
 * When the announced policy text went live, as an ISO UTC instant on or before
 * the day of the version (a page edited after midnight UTC is dated later than
 * its text went live). Only accounts created before it can be owed a notice.
 * Keep it at or AFTER the moment the page text behind everything the summary
 * announces is live in production, never before: an earlier instant skips the
 * accounts created between it and that moment who may still need a notice.
 * A later instant can also include accounts created under the new text. Page
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
 * Version 2026-11-20.6 describes the browser's week-one return mark and the
 * existing PostHog events used to measure returns. Version 2026-11-20.7 adds
 * account and browser storage of interest priorities, mix and area levels,
 * including guest choices awaiting sign-in.
 * Version 2026-11-20.8 adds the optional ORCID citation lookup for weekly emails.
 * Version 2026-11-20.9 adds the session sample for activity before a profile loads.
 * Version 2026-11-21 adds rate-limit counters for ORCID connection changes.
 * Publish the notice before the Worker starts collecting those counters.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-21T23:59:59Z';

/**
 * Notices through this version are retired for every account. A recorded
 * version at or after it counts as a notice shown. The 2026-11-07 notice went
 * live at 08:04Z that day when only each browser remembered it, so a reader
 * who had seen it would have seen it again on every new browser or device.
 * Pablo retired that notice for all accounts on 2026-11-07 (ENG-196).
 * Keep this date. Raising it would retire later notices and could make
 * accounts with older records eligible to see another notice.
 */
export const PRIVACY_NOTICE_BASELINE_VERSION = '2026-11-07';

/** At most three short bullets, the dialog's whole message, in display order. */
export const PRIVACY_POLICY_CHANGE: readonly string[] = [
  'Cloudflare counts requests to change your ORCID connection under a hashed account identifier that changes by action and hour. The counters are scheduled for deletion one hour after the UTC day ends.',
];

/** The clauses in the notice and the policy text that supports them. */
export const PRIVACY_POLICY_CHANGE_EVIDENCE: {
  lead: string;
  clauses: readonly (readonly [said: string, onPage: RegExp])[];
  unsaid: readonly (readonly [claim: RegExp, why: string])[];
} = {
  lead: 'Cloudflare',
  clauses: [
    ['requests to change your ORCID connection', /To limit requests that change your ORCID connection/],
    ['hashed account identifier that changes by action and hour', /hashed account identifier that changes by action and hour/],
    ['scheduled for deletion one hour after the UTC day ends', /scheduled for deletion one hour after the UTC day ends/],
  ],
  unsaid: [
    [/anonymous/i, 'the counter is keyed by a hash derived from the account identifier'],
  ],
};
