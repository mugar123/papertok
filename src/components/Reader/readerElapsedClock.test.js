import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * How long the reader has been waiting, said out loud.
 *
 * A rewrite of a long paper spends a minute or more before its first section,
 * and the ghost block said only which stage it was in — so a wait that was
 * working and a wait that had died looked identical, and the honest answer to
 * "is this stuck?" was to close the reader and find out. The pings already carry
 * `elapsedMs`; the service already forwards it. All that was missing was
 * printing it.
 *
 * Source tests, like `readerErrorCopy` and `readerMobileStyles`: the component
 * mounts a portal over a streaming effect, and what needs holding here is the
 * wiring and the one CSS property that keeps the digits from shoving the label
 * around.
 */

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the ghost block shows the elapsed time the pings carry', async () => {
  const jsx = stripComments(await read('./PaperReader.jsx'));

  // The callback has to take the number, not only the stage.
  assert.match(jsx, /onProgress: \(\{ stage: nextStage, elapsedMs \}\)/);
  assert.match(jsx, /setElapsedMs\(/);
  assert.match(jsx, /function formatElapsed\(ms\)/);
  assert.match(jsx, /\{formatElapsed\(elapsedMs\)\}/);
  assert.match(jsx, /className="rd-ghost-clock"/);
  // The stage owns the live region; a clock that announced itself every eight
  // seconds would talk over the reader's screen reader for the whole wait.
  assert.match(jsx, /className="rd-ghost-clock" aria-hidden="true"/);
});

test('a new rewrite starts the clock again', async () => {
  const jsx = stripComments(await read('./PaperReader.jsx'));
  // `load` clears the stage before every request that reaches the worker; the
  // clock has to be cleared in the same breath or the next wait starts at the
  // last one's total.
  assert.match(jsx, /setStage\('source'\);\n\s*setElapsedMs\(0\);/);
});

/**
 * `elapsedMs: 0` was being sent on `meta` and on every section as filler beside
 * the stage those calls existed to set. Printed, that filler walks the clock
 * back to 0:00 each time a section lands — the one moment the reader can see
 * that progress is being made.
 */
test('only a ping claims to know how long it has been', async () => {
  const service = stripComments(await read('../../services/paperRewriteService.js'));

  const progressCalls = [...service.matchAll(/onProgress\?\.\(\{[^}]*\}\)/g)].map(match => match[0]);
  assert.equal(progressCalls.length, 3, 'expected the meta, section and ping calls');
  assert.equal(progressCalls.filter(call => /elapsedMs/.test(call)).length, 1);
  assert.match(
    progressCalls.find(call => /elapsedMs/.test(call)),
    /event\.elapsedMs/,
  );
});

test('the digits do not shove the label as the seconds tick', async () => {
  const css = stripComments(await read('./PaperReader.css'));
  const rule = css.match(/\.rd-ghost-clock \{([\s\S]*?)\}/);
  assert.ok(rule, 'expected a .rd-ghost-clock rule');
  assert.match(rule[1], /font-variant-numeric: tabular-nums/);
});
