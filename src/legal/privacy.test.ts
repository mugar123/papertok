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
import { PRIVACY_POLICY_VERSION } from './privacyPolicy.ts';

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

test("the page says the server counts a signed-in reader's requests per account, not only their volume", () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  // The ledger keys per-account limits (feed, follows, embedding, provider minutes) by a SHA-256 of the uid.
  assert.doesNotMatch(html, /not who makes them/);
  assert.match(html, /counts them per account, under a hashed account identifier[^.]*three days/);
});

test('the page promises the in-app announcement and says how a dismissal is remembered', () => {
  const html = stripHtmlComments(read('privacy.html')).replace(/\s+/g, ' ');
  assert.match(html, /the change will be announced in the application itself/);
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
