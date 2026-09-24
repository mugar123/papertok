import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The paper page and the seed a shared link's document carries
 * (worker/share-pages.js → src/utils/shareSeed.js).
 *
 * Googlebot renders JavaScript but may not reach api.papertok.app, whose
 * robots.txt is `Disallow: /`. Without the seed its render ended on the
 * loading or error state, and both are marked noindex (audit 2026-09-23,
 * issue 5). With it, the page is the paper from the first render, the head
 * never says noindex, and a load that fails keeps the seed on screen.
 *
 * Read as source under convention ce139ce: comments stripped, bounded slices,
 * each rule bound in one contiguous pattern.
 */

const JSX = new URL('./PublicPaperPage.jsx', import.meta.url);
const stripComments = source => source
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

async function component() {
  const code = stripComments(await readFile(JSX, 'utf8'));
  const start = code.indexOf('export default function PublicPaperPage(');
  assert.ok(start >= 0, 'the page component is gone');
  return code.slice(start, start + 12_000);
}

test('SOURCE: the share seed is read for this key, and paints only when it can paint the whole paper', async () => {
  const code = await component();
  assert.match(
    code,
    /const shareSeed = useMemo\(\(\) => \{\s*const candidate = readShareSeed\(paperKey\);[\s\S]{0,200}?paperLegacyAdapter\(candidate\)[\s\S]{0,120}?\}, \[paperKey\]\);\s*const sharePainted = !seedPainted && seedPaintsWhole\(shareSeed\);/,
  );
});

test('SOURCE: until the providers answer, the page is the seed, ready and not loading', async () => {
  const code = await component();
  assert.match(
    code,
    /const loadedPaper = hasCurrentResult \? result\.paper : \(seedPainted \? seededPaper : \(sharePainted \? shareSeed : null\)\);/,
  );
  assert.match(
    code,
    /const status = hasCurrentResult\s*\? result\.status\s*: \(seedPainted \|\| sharePainted \? 'ready' : \(identity \? 'loading' : 'not-found'\)\);/,
  );
  assert.match(code, /const \[seededOnArrival\] = useState\(\(\) => seedPainted \|\| sharePainted\);/);
});

test('SOURCE: a load that finds nothing or fails keeps the seed rather than the error', async () => {
  const code = await component();
  const start = code.indexOf('const requestId = ++requestIdRef.current;');
  assert.ok(start >= 0, 'the load effect is gone');
  const effect = code.slice(start, start + 1600);
  assert.match(effect, /const fallback = seededPaper \|\| shareSeed;/);
  assert.match(effect, /setResult\(\{ requestKey, paper: fallback, status: fallback \? 'ready' : 'not-found' \}\);/);
  assert.match(effect, /setResult\(\{ requestKey, paper: fallback, status: fallback \? 'ready' : 'error' \}\);/);
});

test('SOURCE: the head is built from the paper on screen, seed included', async () => {
  const code = await component();
  assert.match(code, /const metadata = useMemo\(\(\) => publicPaperMetadata\(paper, canonicalRoute\), \[canonicalRoute, paper\]\);\s*usePublicPageMetadata\(metadata\);/);
});
