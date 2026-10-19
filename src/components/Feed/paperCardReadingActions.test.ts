import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * SOURCE test for the two reading actions staying put. The Read label can
 * change after a card is shown and "Read in plain words" can arrive with a
 * free copy, so each action has its own slot and no slot depends on the
 * other's width. The row does not rise with the card's arrival either.
 */
test('the reading actions sit in two fixed slots and do not arrive with the card', async () => {
  const css = stripComments(await read('./PaperCard.css'));

  const row = css.match(/\n\.pc-action-primary \{([^}]*)\}/)?.[1] || '';
  assert.match(row, /display: grid;/);
  assert.match(row, /grid-template-columns: repeat\(2, minmax\(0, [^)]+\)\);/);
  assert.doesNotMatch(row, /flex-wrap/, 'a long label never pushes the other action onto a new line');

  const phone = css.slice(css.indexOf('@media (max-width: 640px) {'));
  assert.match(phone, /\.pc-action-primary \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);

  const arriving = css.match(/([^{}]*)\{\s*animation: pcArrive /)?.[1] || '';
  assert.ok(arriving.includes('.pc-abstract'), 'the arrival rule is the one found');
  assert.ok(!arriving.includes('.pc-action-bar'), 'the action row is in place from the first frame');

  const jsx = await read('./PaperCard.tsx');
  assert.doesNotMatch(jsx, /animateSize\(button, 'width'/, 'the Read button no longer changes width');
});
