import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const source = async () => stripComments(await readFile(new URL('./ListsPage.tsx', import.meta.url), 'utf8'));

/**
 * SOURCE tests (PAP-47). The index of lists and an open list take turns in one
 * AnimatePresence, and the swap scrolled the window to the top both ways: a
 * reader who opened a list halfway down the index and closed it again landed
 * at the top, away from the list they had just left, with focus on <body>.
 */

const enterListBody = (code: string) => {
  const enter = code.match(/const enterList = \(list: OwnList\) => \{([\s\S]*?)\n {2}\};/);
  assert.ok(enter, 'enterList is gone');
  return enter[1];
};

const indexMemory = (code: string) => {
  const memory = enterListBody(code).match(/(\w+)\.current = \{([^}]*)\}/);
  assert.ok(memory, 'opening a list from the index does not remember the index');
  return { name: memory[1], fields: memory[2] };
};

test('SOURCE: opening a list from the index remembers where the index was and which list was opened', async () => {
  const code = await source();
  const memory = indexMemory(code);
  assert.match(memory.fields, /window\.scrollY/, 'the window position at the moment the list opens');
  assert.match(memory.fields, /list\.id/, 'the list the reader opened');
  // Coming back from a paper opens the list through openList itself: the index
  // was never on screen in that visit, so there is nothing true to remember.
  const writes = code.match(new RegExp(`\\b${memory.name}\\.current = \\{`, 'g')) ?? [];
  assert.equal(writes.length, 1, 'only the reader\'s own open records the index');
});

const indexRestoreBody = (code: string) => {
  const index = code.match(/<motion\.div key="index"([^>]*)>/);
  assert.ok(index, 'the index view is gone');
  // When the index is in the document again. AnimatePresence calls
  // onExitComplete before the next view is committed, so a position restored
  // there clamps to the height of the list that is leaving.
  const refName = index[1].match(/\bref=\{(\w+)\}/)?.[1];
  assert.ok(refName, 'nothing acts when the index is back on screen');
  const restore = code.match(new RegExp(`const ${refName} = useCallback\\(\\(([^)]*)\\) => \\{([\\s\\S]*?)\\n {2}\\}, \\[\\]\\);`));
  assert.ok(restore, `${refName} is not a stable ref callback`);
  return restore[2];
};

test('SOURCE: the index comes back where it was left, on the list that was open, once', async () => {
  const code = await source();
  const memory = indexMemory(code);
  const body = indexRestoreBody(code);
  assert.match(body, new RegExp(`\\b${memory.name}\\.current\\b`), 'it reads what the open remembered');
  assert.match(body, new RegExp(`\\b${memory.name}\\.current = null;`), 'and spends it: a later mount of the index does not jump');
  assert.match(body, /window\.scrollTo\(\{ top: \w+\.top, behavior: 'instant' \}\)/, 'instantly: never a glide, with or without reduced motion');
  assert.doesNotMatch(body, /smooth/);
  assert.match(body, /\[data-list-id="\$\{CSS\.escape\(\w+\.listId\)\}"\]/, 'focus goes back to the list that was open');
  assert.match(body, /\.focus\(\{ preventScroll: true \}\)/, 'without scrolling away from the restored position');
  assert.match(code, /className="list-card-name-btn"\s+data-list-id=\{list\.id\}/, 'the list card\'s name button is that target');
});

test('SOURCE: the list that was open is back in sight below the navbar, even after the window changed', async () => {
  const body = indexRestoreBody(await source());
  // The remembered position fits the layout the reader left. Resizing the
  // window or turning a phone while the list is open lays the index out again,
  // and the same position can then leave the focused name off screen: 375x812
  // turned to 812x375 left it 32px above the viewport.
  const name = body.match(/const (\w+) = \w+\.querySelector<HTMLElement>\(`\[data-list-id=/)?.[1];
  assert.ok(name, 'the restore does not keep hold of the name it focuses');
  assert.match(
    body,
    new RegExp(`\\b${name}\\??\\.scrollIntoView\\(\\{ block: 'nearest', behavior: 'instant' \\}\\)`),
    'only as far as it takes to show it, so an unchanged layout stays where it was, and never with a glide',
  );
  const css = await readFile(new URL('./ListsPage.css', import.meta.url), 'utf8');
  const rule = css.match(/\.list-card-name-btn \{([^}]*)\}/)?.[1];
  assert.ok(rule, 'the name button has no rule');
  // The navbar is fixed over the top of the page: a name scrolled to the top
  // edge would sit under it, focused and hidden.
  assert.match(rule, /scroll-margin-(?:block|top):[^;]*var\(--nav-total\)/, 'it stops below the fixed navbar');
});

test('SOURCE: a list still opens at its top', async () => {
  const code = await source();
  assert.doesNotMatch(enterListBody(code), /scrollTo/, 'the open does not scroll the index away under the reader before it leaves');
  assert.match(code, /onExitComplete=\{\(\) => window\.scrollTo\(\{ top: 0, behavior: 'instant' \}\)\}/);
});
