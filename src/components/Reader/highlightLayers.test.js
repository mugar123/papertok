import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * A selection over a sentence the model had underlined used to take the
 * underline away: `resolveHighlightRanges` dropped whichever range came
 * second, and the reader's own marks come first. Measured 2026-09-17 (see
 * docs/AUDITORIA-LECTOR-SELECCION-2026-09-17.md): the AI mark count went
 * 1 -> 0 the frame the provisional wash painted, and stayed 0 once saved.
 * The engine now keeps both and says who is underneath; this pins the two
 * halves that make it visible.
 */
test('a mark the reader lays over a model underline keeps the underline running beneath it', async () => {
  const jsx = stripComments(await read('./HighlightedScientificText.jsx'));
  assert.match(jsx, /item\.under\?\.includes\('ai'\) && item\.source !== 'ai' \? 'rd-mark--over-ai' : ''/);
  const css = stripComments(await read('./PaperReader.css'));
  const rule = css.match(/\.rd-mark--over-ai\.rd-mark--over-ai \{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /box-shadow: inset 0 -2px 0 var\(--accent-primary\);/);
  // After the rule that takes the box-shadow off the reader's own marks, or it loses.
  assert.ok(css.indexOf('.rd-mark--user.rd-mark--user {') < css.indexOf('.rd-mark--over-ai.rd-mark--over-ai {'));
});
