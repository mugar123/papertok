import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
/** Comments quote the very code these tests pin, so they are stripped first. */
const strip = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for what Research shows on a SECOND visit.
 *
 * Measured 2026-09-11 (production build, real session, For you -> Research):
 * the page reached rest at 275ms and the hero only replaced its skeleton at
 * ~311ms, with the sidebar's figures still changing at 894ms — and the same
 * thing happened on every visit, because nothing outlived the unmount.
 * `loading` starts true and the mount effect calls `fetchReport` without
 * `quiet`, so even a corpus the service already has cached costs a skeleton.
 *
 * The rest of the app answers this with `createSessionCache`: seed from what
 * this tab already showed, paint at once, and let the fresh read replace it
 * behind. See `profileSessionCaches.js` and `CommentsSheet.jsx` for the two
 * screens that already do it.
 */

test('Research keeps this tab\'s last edition and is seeded from it', async () => {
  const src = strip(await read('./ScientificReport.jsx'));

  assert.match(
    src,
    /import \{ createSessionCache \} from '\.\.\/\.\.\/utils\/sessionCache\.js'/,
    'the same cache the profile and the comments sheet use',
  );
  assert.match(
    src,
    /const reportCache = createSessionCache\(/,
    'module-scoped: it has to outlive the component, which is the whole point',
  );

  // Keyed by what actually changes the edition. A key that ignored the filters
  // would seed one selection's report onto another's.
  assert.match(
    src,
    /const reportCacheKey = \(timeframe, filters\) => JSON\.stringify\(\s*\[timeframe, filters\?\.categories \?\? \[\], filters\?\.countries \?\? \[\]\],\s*\)/,
    'the key is the timeframe and both filter lists',
  );
  // One function, used by both. Two spellings of "the same key" drift apart in
  // silence, and the drift shows up as a seed that never matches a write.
  assert.match(src, /const initialReportKey = reportCacheKey\('7d', \{ categories: \[\], countries: \[\] \}\)/);
  assert.match(src, /const reportKey = useMemo\(\(\) => reportCacheKey\(timeframe, filters\), \[timeframe, filters\]\)/);

  assert.match(
    src,
    /const \[report, setReport\] = useState\(\(\) => reportCache\.get\(initialReportKey\)\?\.report \?\? \{ mainDiscovery: null, highlights: \[\] \}\)/,
    'the first render already has the previous edition',
  );
  assert.match(
    src,
    /const \[trends, setTrends\] = useState\(\(\) => reportCache\.get\(initialReportKey\)\?\.trends \?\? \{ status: 'loading', items: \[\] \}\)/,
  );
  assert.match(
    src,
    /const \[loading, setLoading\] = useState\(\(\) => !reportCache\.get\(initialReportKey\)\)/,
    'a seeded screen is not loading; it is showing something while it revalidates',
  );
});

test('a seeded Research revalidates quietly instead of flashing its skeleton', async () => {
  const src = strip(await read('./ScientificReport.jsx'));
  const start = src.indexOf('trendsRef.current = null;');
  assert.notEqual(start, -1, 'the effect that (re)builds the edition');
  // Bounded at that effect's own dependency array.
  const effect = src.slice(start, src.indexOf('}, [timeframe, filters', start));

  assert.match(effect, /const cached = reportCache\.get\(reportKey\)/);
  assert.match(
    effect,
    /fetchReport\(timeframe, filters, 1, \{ refreshTrends: true, quiet: Boolean\(cached\) \}\)/,
    '`quiet` is what keeps `setLoading(true)` from firing over data already on screen',
  );
  assert.match(
    effect,
    /if \(cached\) \{[\s\S]*?setReport\(cached\.report\)[\s\S]*?setTrends\(cached\.trends\)[\s\S]*?setLoading\(false\)/,
    'a filter change seeds too, not just the mount',
  );
  assert.match(
    effect,
    /if \(!cached\) \{\s*setTrends\(/,
    'the trends are only knocked back to loading when there is nothing to show',
  );
});

test('the edition is remembered only once it is worth showing', async () => {
  const src = strip(await read('./ScientificReport.jsx'));
  const start = src.indexOf('reportCache.set(');
  assert.notEqual(start, -1, 'something writes the cache');
  const effect = src.slice(src.lastIndexOf('useEffect', start), src.indexOf('}, [', start));

  assert.match(
    effect,
    /if \(loading \|\| error \|\| !report\?\.mainDiscovery\) return/,
    'a half-built or failed edition must never be what the next visit paints',
  );
  assert.match(effect, /reportCache\.set\(reportKey, \{ report, trends \}\)/);
});
