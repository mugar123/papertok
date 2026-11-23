/**
 * The privacy page as a Vite entry: what the built document must say, and
 * what it must never load.
 *
 * HTML comments are stripped before asserting, so a comment that names the
 * thing we forbid cannot pass the check for its absence, and one that quotes
 * the thing we require cannot pass the check for its presence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRIVACY_NOTICE_SHOWN_FROM, PRIVACY_POLICY_CHANGE, PRIVACY_POLICY_CHANGE_EVIDENCE, PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from './privacy-policy.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (rel: string|URL) => readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8');
const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');

test('the page lives at the repo root as a Vite entry, not in public/', () => {
  assert.ok(existsSync(fileURLToPath(new URL('privacy.html', ROOT))), 'privacy.html at the root');
  assert.ok(!existsSync(fileURLToPath(new URL('public/privacy.html', ROOT))), 'public/privacy.html must be gone or it would shadow the built page');
});

test('the document is English and canonical at /privacy.html', () => {
  const html = stripHtmlComments(read('privacy.html'));
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/papertok\.app\/privacy\.html" \/>/);
  assert.match(html, /<title>Privacy policy — PaperTok<\/title>/);
});

test('the document loads no font or script from outside the site', () => {
  const html = stripHtmlComments(read('privacy.html'));
  assert.doesNotMatch(html, /googleapis|gstatic|cdnjs|jsdelivr|unpkg/);
});

test('the summary up top says the five things a reader needs', () => {
  const html = stripHtmlComments(read('privacy.html'));
  const block = html.match(/<section class="lp-short"[\s\S]*?<\/section>/)?.[0];
  assert.ok(block, 'an "In short" section');
  const items = block.match(/<li>/g) || [];
  assert.equal(items.length, 5);
  assert.match(block, /without an account/);
  assert.match(block, /cookies/);
  assert.match(block, /sold/);
  assert.match(block, /Settings/);
  // Settings needs an account; a visitor is told where their switch is.
  assert.match(block, /Privacy button/);
  assert.match(block, /mailto:nicomg60@gmail\.com/);
});

test('every section of the Spanish policy survives the translation', () => {
  const html = stripHtmlComments(read('privacy.html'));
  const headings = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(headings, [
    'In short',
    'Who is responsible',
    'You can use PaperTok without an account',
    'What is collected if you create an account',
    'What is public and what is not',
    'University email verification',
    'Zotero',
    'ORCID',
    'Email updates',
    'Analytics',
    'Scientific sources and AI features',
    'Who it is shared with',
    'How long it is kept',
    'Your rights',
    'Storage in your browser',
    'Changes',
  ]);
});

test('the page says papers you liked, saved or opened reach the catalogue and Workers AI, without the reader', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.doesNotMatch(html, /your likes [^.]*not sent to it/);
  // Opening a paper asks for related ones by its id, as a like does (FeedContext's network expansion).
  assert.match(html, /opening a paper [^.]*related[^.]*identifier/);
  assert.match(html, /paper you liked, saved or opened that the catalogue does not have yet is added/);
  assert.match(html, /papers you liked, saved or opened have no vector[^.]*sent to it[^.]*without your identity/);
});

test('the page says analytics records opening a paper\'s connections or similar papers and what is done in the connections map', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // connections_open, similar_open and connections_interact in analytics-service.ts.
  assert.match(html, /also record when you open a paper's connections or its similar papers, and what you do in the connections map, such as switching to the list or centring the graph on another paper/);
});

test('the page says what the server keeps of the feed order ranked for a reader, where, for how long, and, up top too, that deleting the account leaves it to expire', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // worker/paper-feed.ts `rankingCache`: a walk's order lasts WALK_KEPT_MS from its last page.
  assert.match(html, /keeps the order it ranked for you, and how far down it you got, for up to 2 hours after your last page/);
  // wrangler.toml `[placement] region` places the fetch handler, and so this cache write, near
  // Frankfurt; Cloudflare picks the data center and may change it, so the page names no fixed city.
  assert.match(html, /kept in the cache of the Cloudflare data center where that server runs \(placed near Frankfurt; Cloudflare may move it to a nearby data center\)/);
  assert.match(html, /Deleting your account does not remove it sooner/);
  const summary = html.match(/<section class="lp-short".*?<\/section>/)?.[0] ?? '';
  assert.match(summary, /delete your account, and everything in it, [^<]*The feed order the server keeps for you is not deleted with it; it expires on its own, at most 2 hours after your last page/);
});

test("the page says the server counts a signed-in reader's requests per account, not only their volume", () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // The ledger keys per-account limits (feed, follows, embedding, provider minutes) by a SHA-256 of the uid.
  assert.doesNotMatch(html, /not who makes them/);
  assert.match(html, /counts them per account, under a hashed account identifier[^.]*three days/);
});

test('the page names the public pages a shared link opens as places for the Privacy button', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  const where = html.match(/with the <strong>Privacy<\/strong> button ([^.]*)\./)?.[1];
  assert.ok(where, 'the policy no longer says where the Privacy button is');
  assert.match(where, /welcome screens/);
  // The sentence Pablo approved on 2026-10-25, with the conference pages he added on 2026-11-23, word for word.
  assert.ok(
    where.endsWith('screens and of the public pages a shared link opens: a paper, a list, an author, institution, journal, topic or project page, a conference calendar, edition or Papers page, and the page for a link that no longer works'),
    where,
  );
  assert.doesNotMatch(where, /\bfeed\b/);
});

test('the page says figure lookups count against the caller address like the other public lookups', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // worker/source-api.ts gives /resources/figures a per-address allowance through worker/caller-quota.ts.
  assert.match(html, /When the in-app reader requests a paper's text or its PDF, an AI assistant sends a request to\s+PaperTok's MCP server, or a public request looks up\s+papers, paper figures,\s+open-access links or a shared page, or a translation needs a fresh arXiv lookup,\s+that server uses the IP address/);
  // reserveCallerMinute (worker/caller-quota.ts) schedules every per-minute caller counter, figures included, for deletion a minute after its window.
  assert.match(html, /The arXiv, paper-figure, open-access lookup, MCP and conference counters use the same cleanup schedule/);
});

test('the page describes translation data, quota retention, and how to remove the browser preference', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /When you request a translation, PaperTok sends the arXiv title, abstract and chosen language to Anthropic without your identity or email/);
  assert.match(html, /PaperTok keeps the translation in memory while you read the card/);
  assert.match(html, /Your browser remembers the language you chose for your last successful translation on this account and device/);
  assert.match(html, /PaperTok counts daily translation requests against a hashed account identifier for up to three days to enforce usage limits/);
  const storage = html.match(/<h2>Storage in your browser<\/h2>.*?<h2>/)?.[0] ?? '';
  assert.match(storage, /language you chose for your last successful translation under your account identifier, in <code>papertok:paper-translation-language:\$\{uid\}<\/code>\. Signing out, deleting the account from Settings in this browser, or clearing the site's data removes that choice/);
});

// worker/ai-translation.ts handleFullPaperTranslation (the full-paper PR) sends the article text without the account.
test('the page says what a full-paper translation sends to Anthropic, what PaperTok keeps and how long Anthropic keeps it', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /If you request a full-paper translation, PaperTok sends the article text needed for the translation and your chosen language to Anthropic\. PaperTok does not include your account identifier or email\. The article may itself name people\./);
  assert.match(html, /PaperTok keeps the translation in memory while you read and does not store it on its servers\. PaperTok counts requests against a hashed account identifier in Cloudflare to enforce daily limits\. PaperTok schedules deletion within three days, though Cloudflare can run the cleanup late\./);
  // The link lands on the paragraph that says a deleted counter can stay in Cloudflare's recovery history.
  assert.match(html, /<a href="#request-counter-retention">counter recovery policy<\/a> below also applies/);
  assert.match(html, /<p id="request-counter-retention"> The request counters this policy describes/);
  assert.match(html, /Anthropic may process the text in any region it serves and ordinarily deletes API inputs and outputs within 30 days, subject to its agreement with PaperTok and exceptions for policy enforcement and legal obligations\./);
});

// worker/email-subscription-store.ts: only `forget` sets `forgetAt`; worker/account-deletion.ts tries it twice.
test('the page says the count of email changes can stay with no set end if the request that schedules its deletion fails', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /If, when you delete your account, the request that schedules this deletion fails or gets no reply both times PaperTok sends it, the deletion may never be scheduled\. The count, and the mark and record identifiers if the object holds them, can then stay with no set end; none of them holds your address or preferences\./);
  const kept = html.match(/<h2>How long it is kept<\/h2>.*?<h2>/)?.[0] ?? '';
  assert.match(kept, /If the request that schedules the count's deletion fails, the count can stay with no set end \(see Email updates\)\./);
  const summary = html.match(/<section class="lp-short".*?<\/section>/)?.[0] ?? '';
  assert.match(summary, /\(see Email updates\)\. In one rare case, explained there, the count can stay longer\./);
});

// worker/full-text.ts fromArxiv asks arxiv.org/html, then ar5iv.labs.arxiv.org; worker/account-deletion.ts never reaches REQUEST_QUOTA_LEDGER.
test('the page names ar5iv as a source of the reader text and says AI counters outlive a deleted account', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /from <strong>ar5iv<\/strong> \(ar5iv\.labs\.arxiv\.org, also served at ar5iv\.org\), a community service separate from arXiv/);
  assert.match(html, /directly from the service that hosts it \(arXiv, ar5iv, PubMed Central or Europe PMC\)/);
  const kept = html.match(/<h2>How long it is kept<\/h2>.*?<h2>/)?.[0] ?? '';
  assert.match(kept, /Nor are the daily counters of AI explanations, rewrites and translations, kept under a hashed account identifier: their deletion stays scheduled for within three days/);
});

// Digest reminders (#555): the visit hour kept in the account's EmailSubscriptionStore with the reader's consent.
test('the page says what opt-in digest reminders keep, for how long, and that they stay apart from analytics', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /If you subscribe to the weekly digest and verify your email, you can opt in to digest reminders in Settings\. With your consent, PaperTok keeps only the hour of your last signed-in visit when the app is visible, in your account's Cloudflare Durable Object\./);
  assert.match(html, /PaperTok uses the visit for 30 days from the hour it records, then deletes it, and deletes it sooner if you turn reminders off, unsubscribe from the digest or delete your account\./);
  assert.match(html, /if the run does not reach it, the visit stays stored, unused, until PaperTok next reads your subscription/);
  assert.match(html, /PaperTok keeps this visit separate from usage analytics\./);
});

// The conference status and paper-list routes (#583) count each address per route and UTC minute.
test('the page says conference requests have their own per-address limits under protected identifiers', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /Conference requests use separate per-address limits of 30 status requests and 60 paper-list requests per UTC minute, including when the server already has the answer\. The Worker counts these requests under protected identifiers derived from the address, route and minute using a secret key\./);
});

test('the page describes who sees the once-per-account announcement until 0.4', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // Guests and accounts created at or after the effective time are not told (nudges.ts privacyNoticeOwed).
  assert.match(html, /Until PaperTok 0\.4, you will see the current announcement in the app if you sign in to an account created before the change took effect and have no record of seeing an announcement from 7 November 2026 or later/);
  assert.match(html, /Once your account has that record, later changes will appear here without another announcement on any device/);
  // PRIVACY_NOTICE_SHOWN_FROM, read against the reader's clock (nudges.ts privacyNoticeOwed).
  assert.match(html, /The announcement appears from 30 November 2026, as your device's clock reads it\. Without an account, changes appear only on this page\./);
  assert.match(html, /Revision 11 adds full-paper translation by Anthropic, per-minute limits on conference requests, the weekly email started from the welcome screen and how long its records are kept, and opt-in digest reminders\./);
  // PRIVACY_NOTICE_BASELINE_VERSION (src/legal/privacy-policy.ts) settles 2026-11-07 for every account.
  assert.match(html, /The announcement of the 7 November 2026 change is no longer shown, including to accounts that had not seen it/);
  // users/{uid}/settings/privacyNotice (src/services/privacy-notice-service.ts) is listed with the account's data.
  assert.match(html, /<td>The latest version of this policy whose change announcement you were shown<\/td>/);
  // Account deletion removes users/{uid}/settings, where the record lives (USER_SUBCOLLECTIONS in worker/account-deletion.ts).
  assert.match(html, /That deletes [^.]*the record of the latest policy announcement you were shown/);
});

test('the in-app notice announces the version this page is dated', () => {
  const html = stripHtmlComments(read('privacy.html'));
  const shown = html.match(/<p class="lp-updated">Last updated ([^<]+)\.<\/p>/)?.[1];
  assert.ok(shown, 'a "Last updated" date');
  assert.match(PRIVACY_POLICY_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  const day = new Date(`${PRIVACY_POLICY_VERSION.slice(0, 10)}T00:00:00Z`);
  const dated = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(day);
  const revision = PRIVACY_POLICY_VERSION.split('.')[1];
  assert.equal(revision ? `${dated} (revision ${revision})` : dated, shown, 'a dated change to this page bumps PRIVACY_POLICY_VERSION and its summary in src/legal/privacy-policy.ts');
});

test('the current notice announces revision 11: translations, request limits and the weekly email', () => {
  const notice = PRIVACY_POLICY_CHANGE.join(' ');
  assert.match(notice, /^Translations, now including full papers, and explanations go to Anthropic without your account or email, possibly outside the EU\./);
  assert.match(notice, /Limits on translations, OpenAlex lookups and conference pages count hashed or protected IDs, scheduled for deletion within three days/);
  assert.match(notice, /Cloudflare's 30-day recovery history may keep deleted counters/);
  assert.match(notice, /Opt-in reminders use your last signed-in visit hour for 30 days/);
  assert.match(notice, /If account deletion cannot schedule its email cleanup, a change counter and IDs, with no address or preferences, may stay/);
});

test('the notice start is an ISO UTC instant that is not before the effective time', () => {
  // An unparsable start would let the notice open at once (privacyNoticeOwed compares against NaN).
  assert.match(PRIVACY_NOTICE_SHOWN_FROM, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  const from = Date.parse(PRIVACY_NOTICE_SHOWN_FROM);
  assert.ok(!Number.isNaN(from), 'it parses');
  assert.ok(from >= Date.parse(PRIVACY_POLICY_EFFECTIVE_AT), 'the notice does not start before the text is live');
});

test('the effective time is an ISO UTC instant no later than the day of the announced version', () => {
  assert.match(PRIVACY_POLICY_EFFECTIVE_AT, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  const at = new Date(PRIVACY_POLICY_EFFECTIVE_AT);
  assert.ok(!Number.isNaN(at.getTime()), 'it parses');
  // A page edited after midnight UTC may be dated later than the instant its text went live.
  const endOfVersionDay = Date.parse(PRIVACY_POLICY_VERSION.slice(0, 10) + 'T23:59:59.999Z');
  assert.ok(at.getTime() <= endOfVersionDay, 'the text went live no later than the day the page is dated');
});

test('the page says a sign-in that continues in the tab briefly keeps its trip in session storage', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // auth-identity-service.ts keeps { providerId, surface, returnTo } until the page comes back or is restored after Back.
  assert.match(html, /session storage briefly holds the provider, the part of the app that asked and the page to return to[^.]*removed when the page comes back[^.]*after Back/);
});

test('the in-app summary is short: at most three bullets, its lead change up front, the full list left to the page', () => {
  assert.ok(PRIVACY_POLICY_CHANGE.length >= 1 && PRIVACY_POLICY_CHANGE.length <= 3, 'one to three bullets');
  for (const bullet of PRIVACY_POLICY_CHANGE) {
    const sentences = bullet.match(/[.!?](\s|$)/g)?.length ?? 0;
    assert.ok(sentences >= 1 && sentences <= 2, `one or two sentences: "${bullet}"`);
  }
  // The dialog has to fit it on a phone's screen; the page has every detail.
  const characters = PRIVACY_POLICY_CHANGE.join(' ').length;
  assert.ok(characters <= 520, characters + ' characters');
  const { lead } = PRIVACY_POLICY_CHANGE_EVIDENCE;
  const at = PRIVACY_POLICY_CHANGE[0].indexOf(lead);
  assert.ok(at >= 0 && at < 40, `"${lead}" is in the first bullet's lead clause`);
});

test("every clause of the in-app summary is the page's own words", () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  const { clauses, unsaid } = PRIVACY_POLICY_CHANGE_EVIDENCE;
  assert.ok(clauses.length > 0, 'the summary names where on the page it comes from');
  const summary = PRIVACY_POLICY_CHANGE.join(' ');
  for (const [said, onPage] of clauses) {
    assert.ok(summary.includes(said), 'the summary says "' + said + '"');
    assert.match(html, onPage);
  }
  for (const [claim, why] of unsaid) assert.doesNotMatch(summary, claim, why);
});

test('the page lists the notice key among what the browser keeps and what removes it, and says it is remembered once shown', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  const storage = html.match(/<h2>Storage in your browser<\/h2>.*?<h2>/)?.[0] ?? '';
  // NudgeHost keeps the version once the dialog opens or the account's record says so
  // (recordPrivacyNoticeShown and adoptAccountNotice in utils/nudges.ts).
  assert.match(storage, /This browser also keeps, under your account identifier, a copy of the latest policy version whose announcement your account was shown[^.]*sign out and in again/);
  // deleteConfirmedAccount (components/settings) removes the key in the browser the account is deleted from.
  assert.match(storage, /Clearing the site's data removes the copy, and so does deleting the account from Settings in this browser/);
  const changes = html.match(/<h2>Changes<\/h2>.*?<\/p>/)?.[0] ?? '';
  assert.match(changes, /Once the announcement is shown, your account remembers that version however you close it/);
  assert.doesNotMatch(changes, /Hide for now/);
});

// worker/email-notifications.ts `startDigestOptIn` and the welcome hand-off in
// context/email-notifications-context.tsx; `emailDigestOptIn` in context/auth-context.tsx.
test('the page says a welcome yes starts the weekly email when the account is created, and that a yes under the earlier wording waits in the profile', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /If you say yes to the weekly email on the welcome screen, it starts as soon as you finish creating your account/);
  assert.match(html, /Your browser sends that yes to PaperTok's server with the subjects you chose and the version of the welcome's wording you saw/);
  assert.match(html, /If it cannot reach the server, it tries again up to three times over the next few minutes/);
  assert.match(html, /If you said yes while the welcome said the email would start with your first follow, PaperTok keeps that yes in your account profile in <strong>Google Firestore<\/strong>\. When you first follow an author, topic, institution or project, your browser asks PaperTok's server to start the email, which it does unless you have already turned email updates on or off yourself/);
  // legacyFlagSettles (utils/digest-opt-in.ts): any answer, or a refusal no retry changes.
  assert.match(html, /The saved yes is deleted once the email starts, PaperTok finds it cannot start, or you save your email settings yourself/);
  // No per-account record of the yes is kept in the browser any more.
  assert.doesNotMatch(html, /which wording of the welcome's weekly email choice you said yes to, or that this yes no longer applies/);
});

// worker/email-subscription-store.ts: `version`, `cancelledAt` and the cleanup journal outlive the record.
test('the page says a count of changes to the email subscription stays after unsubscribing, and for 30 days, or at most 60, after account deletion, up top too', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /Unsubscribing deletes the subscription\. So that a yes you gave earlier, or a request still on its way, can never turn the email back on, the Durable Object of your account then keeps, under your account identifier and without your address or preferences, a count of the changes made to your email subscription and the number of the change that last ended it/);
  assert.match(html, /Until PaperTok confirms it has deleted the subscription's other email records, the object also keeps their identifiers/);
  assert.match(html, /After you delete your account, the count stays for 30 days and is then deleted, with everything else the object holds; deleting an account that never had the email leaves one for those 30 days too/);
  const summary = html.match(/<section class="lp-short".*?<\/section>/)?.[0] ?? '';
  assert.match(summary, /A count of the changes made to your email subscription, without your address, stays for 30 more days, or at most 60 if deleting your other email records keeps failing, and a deleted email subscription can remain in Cloudflare's storage history for up to 30 days \(see Email updates\)/);
  const kept = html.match(/<h2>How long it is kept<\/h2>.*?<h2>/)?.[0] ?? '';
  assert.match(kept, /The count of the changes made to your email subscription, which holds neither your address nor your preferences, stays for 30 more days, or at most 60 if deleting your other email records keeps failing, and an email subscription or reminder consent deleted from your account's Durable Object can remain in Cloudflare's 30-day storage history/);
});

// worker/email-subscription-store.ts: `resident` outlives the record. worker/email-notifications.ts: an index
// put can land after INDEX_WRITE_DEADLINE_MS, and after a later unsubscribe or account purge.
// worker/account-deletion.ts does not reach RequestQuotaLedger, whose subjects expire on their own.
test('the page says how long the mark of a welcome start and a late index write stay, what stays in a browser that never signs in, and that the request counts outlive the account', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /If the email was started from the welcome screen, the object also keeps a mark that it was\./);
  // Nothing on the page says that these stay without a limit, except when account deletion never schedules their end.
  assert.doesNotMatch(html, /The mark stays as well|stays until that link is used|The count stays after you delete your account|also stays, and (a deleted|an) email subscription/);
  assert.match(html, /leaves one for those 30 days too\. If deleting the subscription's other email records is still failing then, the object waits for it, for at most 30 more days\. The mark is kept and deleted with the count\./);
  assert.match(html, /In the rare case that Cloudflare's storage answers late while the email is being started, its settings saved or an email sent, an entry with your account identifier and the unsubscribe identifier, without your address, can be written to <strong>Cloudflare Workers KV<\/strong> after you have unsubscribed or deleted your account\. It starts no email\. If the email was started from the welcome screen, the entry the schedule reads is removed at its next run\. The entry of the unsubscribe link expires 120 days after it was written\./);
  const kept = html.match(/<h2>How long it is kept<\/h2>.*?<h2>/)?.[0] ?? '';
  assert.match(kept, /The mark that the email was started from the welcome screen is kept and deleted with the count\. An entry that links an unsubscribe identifier to your account identifier, which a late write can leave in Cloudflare Workers KV, expires 120 days after it was written\./);
  assert.match(html, /In a browser that never signs in, these answers stay until you clear this site's data; a yes older than 24 hours stays with them but is not used\./);
  assert.match(kept, /The request counts Cloudflare keeps under hashed account identifiers, to limit test emails, requests to start the email and citation lookups, are not deleted with the account either: they expire on their own within three days, or at the end of their week for citation lookups \(see Email updates\)\./);
});

// wrangler.toml lists EmailSubscriptionStore under new_sqlite_classes: Cloudflare keeps 30 days of
// point-in-time history for that storage. The record holds `displayName` (worker/email-notifications.ts).
test('the page says a deleted subscription can stay in Cloudflare\'s storage history for 30 days, that the subscription holds the sign-in name, and that welcome requests are counted', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /Cloudflare keeps a 30-day point-in-time history of the Durable Object's storage\. A subscription deleted from it, with its address, name, subjects and follows, and reminder consent with its address, can therefore remain in that history for up to 30 more days after you unsubscribe, withdraw the consent or delete your account; PaperTok never reads or restores that history/);
  assert.match(html, /PaperTok stores your email address, the name your sign-in gives \(the email greets you with it\), your sending preferences/);
  // RequestQuotaLedger is a SQLite-backed Durable Object too (wrangler.toml).
  assert.match(html, /The same history covers the request counts Cloudflare keeps in Durable Objects under hashed identifiers/);
  // OPT_IN_ACCOUNT_HOURLY_LIMIT in worker/email-notifications.ts; the ledger keeps a subject for three days.
  assert.match(html, /To limit test emails, and to allow at most ten requests an hour to start the email from the welcome, Cloudflare counts them under a hashed account identifier that it keeps for up to three days/);
});

// utils/guest-interests.ts: `emailDigestConsent` travels with a yes, and `WELCOME_DIGEST_YES_MAX_AGE_MS` bounds it.
test('the page says the browser keeps the welcome answer about the weekly email with its wording version, and that a yes is used only for 24 hours', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  const storage = html.match(/<h2>Storage in your browser<\/h2>.*?<h2>/)?.[0] ?? '';
  assert.match(storage, /This browser saves your welcome interests, area priorities and feed mix, and your answer about the weekly email with the version of the welcome's wording you saw, until they are saved to a new account, an account with existing interests loads, or you sign out or switch accounts/);
  assert.match(storage, /A yes to the weekly email is used only for 24 hours after you give it/);
});
