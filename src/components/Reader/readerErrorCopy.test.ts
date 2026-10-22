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

test('each new code shows the Petri for its kind of failure', async () => {
  const source = stripComments(await read());
  const poses = source.match(/const ERROR_POSES = \{([\s\S]*?)\n\} as const;/);
  assert.ok(poses, 'expected an ERROR_POSES table');

  // Nothing the reader does changes a paper that is too big or a body the model
  // refused: those are lost, not upset.
  assert.match(poses[1], /AI_REQUEST_TOO_LARGE: 'lost'/);
  assert.match(poses[1], /AI_INVALID_REQUEST_UPSTREAM: 'lost'/);
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

/**
 * A saved summary that could not be read is not a failed rewrite: the worker was
 * never asked, and the copy may well exist. A forced retry skips the lookup and
 * could write a new copy over the saved one, so this retry has to look it up again.
 */
test('a saved summary that could not be read has its own copy, and its retry looks it up again', async () => {
  const source = stripComments(await read());
  assert.match(errorCopyBlock(source), /AI_SAVED_SUMMARY_READ_FAILED: \{/);

  const errorState = source.match(/className="rd-error-state"[\s\S]*?<\/EmptyState>/);
  assert.ok(errorState, 'expected the reader error state');
  const onClick = errorState[0].match(/\{canRetry && \(\s*<Button\b[^>]*?onClick=\{(\w+)\}/);
  assert.ok(onClick, 'expected the error state retry to call a named handler');
  const handler = source.match(new RegExp(String.raw`const ${onClick[1]} = \(\) => \{([\s\S]*?)\n {2}\};`));
  assert.ok(handler, `expected ${onClick[1]} in the reader`);
  const force = handler[1].match(/load\(level, \{ force: ([^}]+?) \}\)/);
  assert.ok(force, 'expected the retry to load the current level again');
  const forcedAfter = new Function('shownError', `return ${force[1]};`) as (code: string) => boolean;
  assert.equal(forcedAfter('AI_SAVED_SUMMARY_READ_FAILED'), false);
  // A failed rewrite still asks the worker to replace what it kept of it.
  assert.equal(forcedAfter('AI_TIMEOUT'), true);
});
