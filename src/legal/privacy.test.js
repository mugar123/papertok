/**
 * The privacy page as a Vite entry: what the built document must say, and
 * what it must never load.
 *
 * Source tests, so comments are stripped before asserting — a comment that
 * names the thing we forbid would otherwise pass the check for its absence,
 * and one that quotes the thing we require would pass the check for its
 * presence (see docs on source-test hardening, ce139ce).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8');
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

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

test('no font or script comes from outside the site', () => {
  const html = stripHtmlComments(read('privacy.html'));
  assert.doesNotMatch(html, /googleapis|gstatic|cdnjs|jsdelivr|unpkg/);
  const css = stripCssComments(read('src/legal/privacy.css'));
  assert.doesNotMatch(css, /https?:\/\//);
});

test('the theme is decided before first paint by the same mirror the app uses', () => {
  const html = stripHtmlComments(read('privacy.html'));
  /* Both halves of the mirror: the stored choice and the system fallback. */
  assert.match(html, /localStorage\.getItem\('papertok_theme'\)/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /setAttribute\('data-theme'/);
  /* And no OS-only media query in the stylesheet doing a second, disagreeing job. */
  const css = stripCssComments(read('src/legal/privacy.css'));
  assert.doesNotMatch(css, /prefers-color-scheme/);
});

test('the stylesheet shares the app tokens and self-hosted faces instead of forking them', () => {
  const css = stripCssComments(read('src/legal/privacy.css'));
  assert.match(css, /@import\s+'\.\.\/styles\/variables\.css'/);
  assert.match(css, /@import\s+'@fontsource-variable\/newsreader\/opsz\.css'/);
  assert.match(css, /@import\s+'@fontsource\/inter\/400\.css'/);
  /* The old page's violet, which belongs to nobody. */
  assert.doesNotMatch(css, /#7c5cff|#a893ff/i);
  /* No uppercase-mono table headers: labels are sentences here. */
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
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

test('the build knows the second page and keeps the app entry named index', () => {
  const config = read('vite.config.js').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const input = config.match(/input:\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(input, /\bindex:\s*fileURLToPath\(new URL\('\.\/index\.html'/);
  assert.match(input, /\bprivacy:\s*fileURLToPath\(new URL\('\.\/privacy\.html'/);
});
