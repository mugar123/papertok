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
  // The sentence Pablo approved on 2026-10-25, word for word.
  assert.ok(
    where.endsWith('screens and of the public pages a shared link opens: a paper, a list, an author, institution, journal, topic or project page, and the page for a link that no longer works'),
    where,
  );
  assert.doesNotMatch(where, /\bfeed\b/);
});

test('the page says figure lookups count against the caller address like the other public lookups', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // worker/source-api.ts gives /resources/figures a per-address allowance through worker/caller-quota.ts.
  assert.match(html, /a public request looks up papers, paper figures, open-access links or a shared page, that server uses the IP address/);
  // reserveCallerMinute (worker/caller-quota.ts) schedules every per-minute caller counter, figures included, for deletion a minute after its window.
  assert.match(html, /The arXiv, paper-figure and open-access lookup counters use the same cleanup schedule/);
});

test('the page says a sign-in that continues in the tab briefly keeps its trip in session storage', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // auth-identity-service.ts keeps { providerId, surface, returnTo } until the page comes back or is restored after Back.
  assert.match(html, /session storage briefly holds the provider, the part of the app that asked and the page to return to[^.]*removed when the page comes back[^.]*after Back/);
});
