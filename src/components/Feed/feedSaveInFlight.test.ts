import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p: string|URL) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * Reproduced 2026-10-21 against the Firestore emulator behind a 120 ms proxy:
 * 30 clicks on Save produced 6 visible changes and 29 toasts, the button sat
 * unchanged for up to 3 s, and it flipped again 1.7 s after the last click.
 * Every click started its own save or unsave from the state it saw, so the
 * clicks that landed mid-operation repeated it and queued more writes.
 */
test('SOURCE: a paper runs one save or unsave at a time, Undo included', async () => {
  const src = strip(await read('./FeedContainer.tsx'));
  const guardFrom = src.indexOf('const runSave = useCallback(');
  const handlerFrom = src.indexOf('const handleSaveToList = useCallback(');
  const handlerTo = src.indexOf('}, [', handlerFrom);
  assert.ok(guardFrom > 0 && handlerFrom > guardFrom && handlerTo > handlerFrom, 'the guard and the handler are still there, in that order');

  const guard = src.slice(guardFrom, handlerFrom);
  assert.match(guard, /if \(savesInFlight\.current\.has\(id\)\) return Promise\.resolve\(\);\s*savesInFlight\.current\.add\(id\);/,
    'a click on a paper whose operation is running does nothing');
  assert.match(guard, /\.finally\(\(\) => \{ savesInFlight\.current\.delete\(id\); \}\)/,
    'the paper is released however the operation ends, so a failure cannot lock the button');

  const handler = src.slice(handlerFrom, handlerTo);
  const body = handler.slice(handler.indexOf('return runSave(id, async () => {'));
  assert.ok(body.length < handler.length, 'the whole operation runs inside the guard');
  assert.match(body, /savedPaperIds\.has\(id\)/, 'the saved state is read inside the guard, after the previous operation settled');
  assert.match(body, /onClick: \(\) => \{ runSave\(id, \(\) => restoreSave\(/, 'Undo waits its turn like a click');
  assert.doesNotMatch(body, /onClick: \(\) => \{ restoreSave\(/);
});
