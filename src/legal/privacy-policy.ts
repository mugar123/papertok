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
export const PRIVACY_POLICY_VERSION = '2026-11-25.14';

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
 *
 * Version 2026-11-23.10 adds the daily per-address share of the OpenAlex
 * allowance, kept under a protected identifier derived from the address and the
 * day and scheduled for deletion within three days, and says that Cloudflare's
 * 30-day recovery history may keep a deleted request counter of any kind. It
 * ships with #578 in the 23 November release batch, so this instant stands at
 * the last moment of that day. If the merge slips to a later UTC day, move the
 * page's "Last updated" date, this version and this instant to the merge day
 * before merging, and lower this instant to the deployment's success time once
 * it is live. Its summary also carries the point of the 20 November text that
 * Pablo asked to repeat (rewrites and explanations by Anthropic may run outside
 * the EU), which accounts without a notice record since 7 November may not have
 * seen. The page text is live from the merge, but the notice waits for
 * PRIVACY_NOTICE_SHOWN_FROM below: Pablo asked on 2026-11-23 that it appear no
 * earlier than 30 November, with the 0.4 changes. That instant says when the
 * dialog may open, not who is owed it: who is still decided by this instant.
 *
 * Version 2026-11-23.11 adds Voice in the reader (ENG-119): the paragraph text
 * sent to Cartesia, or to ElevenLabs, which keeps it in its request history,
 * when Cartesia cannot answer; the audio PaperTok stores in R2 and plays to
 * every listener of the same paragraph; and the usage event that records only
 * that a paper was read aloud. Asier authorized both providers and what they
 * receive on 2026-11-17, first as version 2026-11-17. It ships with the
 * read-aloud pull request after 2026-11-23.10, and its summary carries that
 * version's points too, since the notice for 2026-11-23.10 has not opened yet.
 * The same rule applies: if the merge slips to a later UTC day, move the page's
 * date, this version and the instant below to the merge day before merging.
 *
 * Version 2026-11-24.12 says PaperTok no longer asks for or uses Essential and
 * Curiosity choices, the feed mix or reading levels by area (ENG-229), and that
 * saving interests removes what an account still holds. It also dates the
 * page text #605 removed with AI translation (ENG-230): the translation request
 * to Anthropic, its daily counter and the browser's remembered language. Both
 * collect less, so the summary keeps the changes of 2026-11-23.10 and .11,
 * whose notice has not opened yet, and this instant stays where they put it.
 *
 * Version 2026-11-24.13 takes out the page's three mentions of followed
 * journals: a reader no longer follows a journal, and the journal follows
 * stored are deleted. It also collects less, so the summary and this instant
 * stay as 2026-11-24.12 left them.
 *
 * Version 2026-11-25.14 says the account also keeps the latest app version the
 * fit survey was shown for, and deletes it with the account (ENG-249), so the
 * survey is asked once per version across devices. Before, only each browser
 * kept that version. It is one version string, no answer, used only to ask
 * less often, so the summary and this instant stay as 2026-11-24.12 left them.
 */
export const PRIVACY_POLICY_EFFECTIVE_AT = '2026-11-23T23:59:59Z';

/**
 * The earliest instant (ISO UTC) at which the in-app notice may open, read
 * against the reader's own clock (privacyNoticeOwed in utils/nudges.ts). Until
 * then nobody is owed it, and no account is asked for its record. A clock set
 * ahead shows it early, one set behind shows it late; the page itself is
 * unaffected. Release 0.4 replaces the once-per-account rule and decides what
 * becomes of it; set a new one only when a notice has to wait for something the
 * page does not.
 */
export const PRIVACY_NOTICE_SHOWN_FROM = '2026-11-30T00:00:00Z';

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
  "When you listen to a paper in the reader, the text of each paragraph is sent to Cartesia, or to ElevenLabs when Cartesia cannot answer, never your identity or your email; PaperTok stores the audio for anyone who listens to the same paragraph.",
  "OpenAlex lookups now count per IP address each day, under a protected day identifier scheduled for deletion within three days; Cloudflare's 30-day recovery history may keep any deleted request counter.",
  'Anthropic may run rewrites/explanations outside the EU.',
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
  // The changes since version 2026-11-20.9: Voice in the reader, the OpenAlex
  // per-address count, Cloudflare's recovery history, and the Anthropic point.
  lead: 'When you listen to a paper',
  clauses: [
    ['When you listen to a paper in the reader, the text of each paragraph is sent to Cartesia', /When you listen to a paper in the reader, the text of each paragraph is sent to Cartesia/],
    ['or to ElevenLabs when Cartesia cannot answer', /When Cartesia cannot answer, the text goes instead to ElevenLabs/],
    ['never your identity or your email', /Both receive the text, never your identity or your email\./],
    ['PaperTok stores the audio for anyone who listens to the same paragraph', /PaperTok's server stores the audio[^.]*plays it to anyone who listens to the same paragraph/],
    ['count per IP address each day', /so that one address cannot use up the day's shared OpenAlex allowance: each address has 1,000 billed units and 3,000 lookups by identifier per UTC day/],
    ['a protected day identifier', /a second identifier, derived the same way from the address and the current day/],
    ['scheduled for deletion within three days', /Each store's deletion is scheduled for at most three days after the first request it receives/],
    ["Cloudflare's 30-day recovery history", /Cloudflare keeps a recovery history of that storage that reaches back 30 days/],
    ['any deleted request counter', /The request counters this policy describes, whether kept under a hashed account identifier, a protected identifier derived from an IP address or a hashed recipient identifier/],
    ['rewrites/explanations', /Paper explanations and rewrites are generated by a Claude language model/],
    ['outside the EU', /Anthropic may process the request in any region it serves, including outside the European Union/],
    ['may keep', /a deleted counter may remain there/],
  ],
  unsaid: [
    [/\bPDF\b|full text|account|uid/i, 'the providers receive paragraph text only, nothing that identifies the reader'],
    [/\bsince \d{1,2} [a-z]+/i, 'the summary says only what changed since the previous version'],
    [/(stores?|keeps?|logs?|records?|counts?) (your|the) IP address/i, 'the counters hold a derived identifier, not the address'],
    [/(is|are|gets?) deleted|deleted (after|within)/i, 'deletion is scheduled, and Cloudflare can run it late'],
    [/PaperTok (reads|uses) the recovery history/i, 'PaperTok has no feature that reads the recovery history'],
  ],
};
