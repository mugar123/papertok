import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * `paper_rewrite` is an attempted Worker request, and a `paper_rewrite_result`
 * with `cached: false` is the outcome of one. A summary saved in the account
 * is returned by `rewritePaper` without a Worker request, so `onRequest`
 * never fires for it (paperRewriteService.test.ts covers that side). Its
 * result must not be reported as an uncached rewrite, or instant replays
 * inflate Worker success counts and durations.
 *
 * A source test rather than a render: the reader imports its stylesheets and
 * the Firebase-backed contexts, so it cannot be loaded under `node --test`.
 */

const read = () => readFile(new URL('./PaperReader.tsx', import.meta.url), 'utf8');
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('a rewrite result counts as uncached only when the Worker was asked', async () => {
  const source = stripComments(await read());
  const call = source.match(/await rewritePaper\(([\s\S]*?)\n\s*\} catch \(caught\)/);
  assert.ok(call, 'expected the rewritePaper call inside the reader');

  const onRequest = call[1].match(/onRequest: \(\) => \{([\s\S]*?)\n\s*\},/);
  assert.ok(onRequest, 'expected an onRequest callback');
  assert.match(onRequest[1], /trackEvent\('paper_rewrite',/);

  const result = call[1].match(/trackEvent\('paper_rewrite_result', \{([\s\S]*?)\}\);/);
  assert.ok(result, 'expected a paper_rewrite_result after the rewrite');
  const cached = result[1].match(/\bcached: ([^,]+),/);
  assert.ok(cached, 'expected the result to carry its cache status');

  // The status follows the request, not a constant: a saved summary sends no
  // `paper_rewrite`, so its result is cached.
  const flag = cached[1].trim().match(/^!(\w+)$/);
  assert.ok(flag, `cached is "${cached[1].trim()}", not derived from whether the Worker was asked`);
  assert.match(onRequest[1], new RegExp(`\\b${flag[1]} = true;`));
});
