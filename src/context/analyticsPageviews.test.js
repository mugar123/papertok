import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('./AnalyticsContext.tsx', import.meta.url);
const APP_HTML = new URL('../../index.html', import.meta.url);

test('SOURCE: a page view is sent on every pathname change, to both services, only while analytics is allowed', async () => {
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
  // the CURRENT pathname, not a value written by hand elsewhere, and both
  // services get the view from the same effect, behind the same consent check.
  // Otherwise a fixed string could satisfy this test while leaking the paper's
  // real id, or the effect could fire without ever reading `location.pathname`.
  assert.match(
    code,
    /if \(consent !== ANALYTICS_CONSENT\.GRANTED\) return;\s*const viewPath = normalizeAnalyticsPath\(location\.pathname\);\s*pageview\(\{ route: viewPath, path: viewPath \}\);\s*trackPageView\(location\.pathname\);\s*\}, \[consent, location\.pathname\]\);/,
    'the page view must wait for consent, be keyed on the pathname and report only its normalized pattern',
  );
  // One emitter per service: a second one would count every visit twice.
  assert.equal(code.match(/\bpageview\(/g)?.length, 1, 'Vercel page views are sent from more than one place');
  assert.equal(code.match(/\btrackPageView\(/g)?.length, 1, 'PostHog page views are sent from more than one place');
});

/**
 * The other half of the same promise, and the half a sanitizer cannot keep.
 *
 * `beforeSend` and `sanitizeAnalyticsCapture` own the analytics PAYLOADS. They
 * own nothing about the requests' headers, and the browser's default referrer
 * policy (`strict-origin-when-cross-origin`) puts the full URL in `Referer` on
 * every SAME-ORIGIN request — which is what the Vercel script and every
 * analytics request to `/ingest` are, on the deployment. Measured in a browser
 * (the probe lived in scripts/diagnostics/ and went with the landing it also
 * checked): reading a
 * paper made the app's own `<script src="/_vercel/insights/script.js">` carry
 * `Referer: <origin>/public/paper/<the real key>`.
 *
 * Under HashRouter this was safe for free — a fragment is stripped out of
 * `Referer` — so nothing in the app ever had to say so. Real paths
 * (src/main.tsx) ended that, and `/privacy.html` still promises "which one
 * never travels". `strict-origin` is the one line that keeps it, for the
 * analytics requests and for every other request the app makes.
 */
test('SOURCE: the app document never puts a path in a Referer header', async () => {
  const html = await readFile(APP_HTML, 'utf8');
  const meta = html.replace(/<!--[\s\S]*?-->/g, '').match(/<meta\s+name="referrer"[^>]*>/i);
  assert.ok(meta, 'the app document declares no referrer policy, so the browser default sends the full path');

  const policy = meta[0].match(/content="([^"]*)"/i)?.[1];
  // Only the policies that never reveal a path. `origin-when-cross-origin` and
  // `strict-origin-when-cross-origin` both send the full URL same-origin, which
  // is exactly the case that leaked, so neither is acceptable here.
  assert.ok(
    ['strict-origin', 'origin', 'no-referrer'].includes(policy),
    `referrer policy ${JSON.stringify(policy)} still sends the full path to our own origin`,
  );
});
