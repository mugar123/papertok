import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * Every failure the reader can be handed has to say what it was.
 *
 * `ERROR_COPY` falls back to `AI_UNAVAILABLE` — "something broke between the reader
 * and the model, retrying usually does it" — for any code it does not know, which is a
 * misleading sentence for both codes below: a paper too big to rewrite and a body
 * the model refused outright are different situations, and no amount of retrying
 * will change either.
 *
 * A source test rather than a render: these are constants in a 1 700-line
 * component that mounts a portal, a Base UI dialog and a streaming effect, and
 * what needs holding is the table, not the tree.
 */

const read = () => readFile(new URL('./PaperReader.tsx', import.meta.url), 'utf8');
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The `en` block of `ERROR_COPY`. */
function errorCopyBlock(source: string) {
  const table = source.match(/const ERROR_COPY = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'expected an ERROR_COPY table');
  const english = table[1].match(/\n {2}en: \{([\s\S]*?)\n {2}\},/);
  assert.ok(english, 'expected an en block in ERROR_COPY');
  return english[1];
}

/** Codes the worker can put on the wire that had no copy of their own. */
const ORPHANS = [
  'AI_REQUEST_TOO_LARGE',
  'AI_INVALID_REQUEST_UPSTREAM',
];

test('every code the worker can emit has reader copy', async () => {
  const block = errorCopyBlock(stripComments(await read()));

  for (const code of ORPHANS) {
    assert.match(block, new RegExp(`${code}: \\{`), `${code} has no copy`);
  }
});

test('each new code says in colour what kind of failure it is', async () => {
  const source = stripComments(await read());
  const tones = source.match(/const ERROR_TONES = \{([\s\S]*?)\n\};/);
  assert.ok(tones, 'expected an ERROR_TONES table');

  // Nothing the reader does changes a paper that is too big or a body the model
  // refused: those are neutral, not red.
  assert.match(tones[1], /AI_REQUEST_TOO_LARGE: 'closed'/);
  assert.match(tones[1], /AI_INVALID_REQUEST_UPSTREAM: 'closed'/);
});

test('the retry button is hidden where pressing it cannot help', async () => {
  const source = stripComments(await read());
  const unretryable = source.match(/const UNRETRYABLE_ERRORS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(unretryable, 'expected an UNRETRYABLE_ERRORS set');

  for (const code of ['AI_REQUEST_TOO_LARGE', 'AI_INVALID_REQUEST_UPSTREAM']) {
    assert.match(unretryable[1], new RegExp(`'${code}'`), `${code} would offer a retry that reprints the same screen`);
  }
});

/**
 * «Se han acabado los usos de hoy» is true of the reader's own ten and false of
 * the provider's ceiling, which is the far more common 429 — and the two need
 * opposite advice: one is "come back tomorrow", the other is "try again in a
 * minute". The worker already separates them with `quota.scope`.
 */
test('somebody else\'s ceiling is not shown as the reader\'s own', async () => {
  const source = stripComments(await read());

  assert.match(source, /quota\?\.scope === 'provider'/);
  // Which means the error state has to keep the quota, not just the code.
  assert.doesNotMatch(source, /setError\(caught instanceof PaperRewriteError \? caught\.code : 'AI_UNAVAILABLE'\)/);
});
