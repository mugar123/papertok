import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * Every failure the reader can be handed has to say what it was.
 *
 * `ERROR_COPY` falls back to `AI_UNAVAILABLE` — «algo falló entre el lector y el
 * modelo, reintentar suele bastar» — for any code it does not know, which is a
 * true sentence for exactly one of the codes below and a misleading one for the
 * rest: a paper too big to rewrite, a source that would not download, a body the
 * model refused outright and a monthly budget that ran out are four different
 * situations, three of which no amount of retrying will change.
 *
 * A source test rather than a render: these are constants in a 1 700-line
 * component that mounts a portal, a Base UI dialog and a streaming effect, and
 * what needs holding is the table, not the tree.
 */

const read = () => readFile(new URL('./PaperReader.jsx', import.meta.url), 'utf8');
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The `es` and `en` halves of `ERROR_COPY`, separately. */
function errorCopyBlocks(source) {
  const table = source.match(/const ERROR_COPY = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'expected an ERROR_COPY table');
  const spanish = table[1].match(/\n {2}es: \{([\s\S]*?)\n {2}\},/);
  const english = table[1].match(/\n {2}en: \{([\s\S]*?)\n {2}\},/);
  assert.ok(spanish && english, 'expected both languages in ERROR_COPY');
  return { es: spanish[1], en: english[1] };
}

/** Codes the worker can put on the wire that had no copy of their own. */
const ORPHANS = [
  'AI_REQUEST_TOO_LARGE',
  'AI_SOURCE_UNAVAILABLE',
  'AI_INVALID_REQUEST_UPSTREAM',
  'AI_FALLBACK_BUDGET_EXHAUSTED',
];

test('every code the worker can emit has reader copy, in both languages', async () => {
  const blocks = errorCopyBlocks(stripComments(await read()));

  for (const language of ['es', 'en']) {
    for (const code of ORPHANS) {
      assert.match(blocks[language], new RegExp(`${code}: \\{`), `${code} has no ${language} copy`);
    }
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
  // A mirror that would not answer and a budget that resets are both "come back".
  assert.match(tones[1], /AI_SOURCE_UNAVAILABLE: 'wait'/);
  assert.match(tones[1], /AI_FALLBACK_BUDGET_EXHAUSTED: 'wait'/);
});

test('the retry button is hidden where pressing it cannot help', async () => {
  const source = stripComments(await read());
  const unretryable = source.match(/const UNRETRYABLE_ERRORS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(unretryable, 'expected an UNRETRYABLE_ERRORS set');

  for (const code of ['AI_REQUEST_TOO_LARGE', 'AI_INVALID_REQUEST_UPSTREAM', 'AI_FALLBACK_BUDGET_EXHAUSTED']) {
    assert.match(unretryable[1], new RegExp(`'${code}'`), `${code} would offer a retry that reprints the same screen`);
  }
  // The source being down is worth another go, and so is a fresh download.
  assert.doesNotMatch(unretryable[1], /'AI_SOURCE_UNAVAILABLE'/);
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
