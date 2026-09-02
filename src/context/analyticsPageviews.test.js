import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('./AnalyticsContext.jsx', import.meta.url);

test('SOURCE: a page view is sent on every pathname change, not only when the pattern changes', async () => {
  const source = await readFile(SOURCE, 'utf8');
  // Two papers share the pattern `/public/paper/:id`. Keyed on the pattern,
  // the second one was never a page view; keyed on the pathname it is, and
  // what travels is still only the pattern.
  const tag = source.match(/<Analytics[\s\S]*?\/>/);
  assert.ok(tag, 'the <Analytics /> tag is gone');
  assert.doesNotMatch(tag[0], /\bpath=/, '<Analytics path> re-emits on pattern change only');
  assert.match(tag[0], /\broute=/, 'route= is what disables the script\'s own tracking');
  assert.match(source, /import \{ pageview \} from '@vercel\/analytics';/);
  assert.match(
    source,
    /pageview\(\{ route: viewPath, path: viewPath \}\);\s*\}, \[consent, location\.pathname\]\);/,
  );
});
