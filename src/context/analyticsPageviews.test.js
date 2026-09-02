import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('./AnalyticsContext.jsx', import.meta.url);

test('SOURCE: a page view is sent on every pathname change, not only when the pattern changes', async () => {
  const source = await readFile(SOURCE, 'utf8');
  // Comments are prose, not code: a comment that happens to mention `<Analytics`
  // or `path=` must never change what this test sees. Strip them first, the same
  // way analyticsService.test.js does, so only real code is scanned below.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  // Two papers share the pattern `/public/paper/:id`. Keyed on the pattern,
  // the second one was never a page view; keyed on the pathname it is, and
  // what travels is still only the pattern.
  const tag = code.match(/<Analytics\b[\s\S]*?\/>/);
  assert.ok(tag, 'the <Analytics /> tag is gone');
  // A real JSX tag is a handful of lines. A much longer capture means the regex
  // ran past the real tag into something else -- `<AnalyticsContext.Provider>`,
  // say -- and every assertion below would be checking the wrong text.
  const tagLines = tag[0].split('\n');
  assert.ok(tagLines.length <= 8, `<Analytics ...> capture spans ${tagLines.length} lines, past a single tag`);
  assert.doesNotMatch(tag[0], /\bpath=/, '<Analytics path> re-emits on pattern change only');
  assert.match(tag[0], /\broute=/, 'route= is what disables the script\'s own tracking');

  assert.match(code, /import \{ pageview \} from '@vercel\/analytics';/);
  // Ties the emitted value to its source: it must be the normalized pattern of
  // the CURRENT pathname, not a value written by hand elsewhere. Otherwise a
  // fixed string could satisfy this test while leaking the paper's real id, or
  // the effect could fire without ever reading `location.pathname` at all.
  assert.match(
    code,
    /const viewPath = normalizeAnalyticsPath\(location\.pathname\);\s*pageview\(\{ route: viewPath, path: viewPath \}\);\s*\}, \[consent, location\.pathname\]\);/,
    'the page view must be keyed on the pathname and report only its normalized pattern',
  );
});
