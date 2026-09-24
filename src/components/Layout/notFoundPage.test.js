import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * An address nobody declared used to land on /feed without a word
 * (`<Route path="*" element={<Navigate to="/feed" replace />}>`), and the
 * server answered 200 for anything (audit 2026-09-23, issue 12). Now the
 * client says the page does not exist, in its own <main> with an h1, marked
 * noindex, with the way to the feed as a link; `/` still reaches /feed.
 *
 * Read as source under convention ce139ce: comments stripped, bounded
 * slices, pieces bound in one contiguous pattern.
 */

const stripComments = source => source
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('SOURCE: the not-found page is one main with one h1 and a link to the feed', async () => {
  const code = stripComments(await read('./NotFoundPage.jsx'));
  const markup = code.slice(code.indexOf('return ('), code.indexOf('return (') + 1500);
  assert.equal((markup.match(/<main\b/g) || []).length, 1);
  assert.equal((markup.match(/<h1\b/g) || []).length, 1);
  assert.match(markup, /<main className="not-found-page">\s*<div className="not-found-card">\s*<h1[^>]*>\{copy\.title\}<\/h1>\s*<p>\{copy\.body\}<\/p>\s*<Link to="\/feed" className="not-found-action">/);
});

test('SOURCE: the not-found page says so in both languages and is kept out of an index', async () => {
  const code = stripComments(await read('./NotFoundPage.jsx'));
  assert.match(code, /es: \{\s*title: 'No encontramos esta página',/);
  assert.match(code, /en: \{\s*title: 'We could not find this page',/);
  assert.match(code, /usePublicPageMetadata\(metadata\)/);
  assert.match(code, /noIndex: true/);
});

test('SOURCE: / reaches the feed, and every other undeclared address the not-found page', async () => {
  const code = stripComments(await read('../../App.jsx'));
  const routes = code.slice(code.indexOf('<Routes'), code.indexOf('</Routes>'));
  const root = routes.indexOf('<Route path="/" element={<Navigate to="/feed" replace />} />');
  const wildcard = routes.search(/<Route\s+path="\*"\s+element=\{\s*<PageTransition>\s*<NotFoundPage \/>\s*<\/PageTransition>\s*\}\s*\/>/);
  assert.ok(root >= 0, 'the explicit / route is gone');
  assert.ok(wildcard > root, 'the not-found route is the last one');
  assert.doesNotMatch(routes, /path="\*"\s+element=\{<Navigate/, 'no silent bounce to /feed');
});
