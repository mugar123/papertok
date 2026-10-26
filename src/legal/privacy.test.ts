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
import { PRIVACY_POLICY_CHANGE, PRIVACY_POLICY_VERSION } from './privacyPolicy.ts';

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

test('the page says what the server keeps of the feed order ranked for a reader, where, for how long, and, up top too, that deleting the account leaves it to expire', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // worker/paper-feed.ts `rankingCache`: a walk's order lasts WALK_KEPT_MS from its last page.
  assert.match(html, /keeps the order it ranked for you, and how far down it you got, for up to 2 hours after your last page/);
  assert.match(html, /cache of the Cloudflare data center that answered you/);
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

test('the page promises the in-app announcement to signed-in accounts and says how a dismissal is remembered', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // Guests and accounts created on or after the policy date are not told (nudges.ts privacyNoticeOwed).
  assert.match(html, /the change will be announced in the application to signed-in accounts created before that date/);
  assert.match(html, /remembers that version, separately for each account/);
});

test('the in-app notice announces the version this page is dated', () => {
  const html = stripHtmlComments(read('privacy.html'));
  const shown = html.match(/<p class="lp-updated">Last updated ([^<]+)\.<\/p>/)?.[1];
  assert.ok(shown, 'a "Last updated" date');
  assert.match(PRIVACY_POLICY_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  const day = new Date(`${PRIVACY_POLICY_VERSION.slice(0, 10)}T00:00:00Z`);
  const dated = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(day);
  assert.equal(dated, shown, 'a dated change to this page bumps PRIVACY_POLICY_VERSION and its summary in src/legal/privacyPolicy.ts');
});

test('the page says a sign-in that continues in the tab briefly keeps its trip in session storage', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // auth-identity-service.ts keeps { providerId, surface, returnTo } until the page comes back or is restored after Back.
  assert.match(html, /session storage briefly holds the provider, the part of the app that asked and the page to return to[^.]*removed when the page comes back[^.]*after Back/);
});

test('the in-app summary is one sentence that tells what the page says goes to the server and to providers', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.equal(PRIVACY_POLICY_CHANGE.match(/[.!?](\s|$)/g)?.length, 1, 'one sentence');
  // Each provider the summary names is one the page lists.
  for (const provider of ['PostHog', 'Resend']) {
    if (PRIVACY_POLICY_CHANGE.includes(provider)) assert.ok(html.includes(provider), provider);
  }
  // What a request for more papers carries, per the page's feed paragraph, is what an account
  // created before the 25 October page was never told: the summary says it in the page's words.
  assert.match(PRIVACY_POLICY_CHANGE, /request for more papers/);
  for (const carried of ['interests', 'what you follow', 'up to 24 papers', 'liked, saved or read at length', 'filter of the papers you viewed']) {
    assert.ok(html.includes(carried), `the page says "${carried}"`);
    assert.ok(PRIVACY_POLICY_CHANGE.includes(carried), `the summary says "${carried}"`);
  }
});

test('the page lists the notice key among what the browser keeps, and says only Got it is remembered', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  const storage = html.match(/<h2>Storage in your browser<\/h2>.*?<h2>/)?.[0] ?? '';
  assert.match(storage, /chosen Got it on the announcement of a policy change[^.]*keeps that version under your account identifier[^.]*sign out and in again/);
  assert.match(html, /When you choose Got it, this browser remembers that version/);
  assert.match(html, /Hiding it with Escape or its close button only hides it for that visit/);
});
