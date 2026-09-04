import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * SOURCE tests: the container is a React component this repo cannot mount
 * under node. They pin the contract of the place-keeping.
 *
 * The place a feed was left at lived in three module-scope maps, which is
 * exactly what a reload of the tab throws away — and the tab reloads itself
 * when a lazy chunk is gone after a deploy (main.jsx). Coming back from the
 * profile then opened the feed at the top and read as the whole feed
 * reloading. The memory now goes through utils/feedResumeMemory.js, which
 * writes through to sessionStorage once the scroll settles and seeds from it.
 */
test('SOURCE: the container keeps its place in a memory that survives a reload', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  assert.match(code, /import \{ createFeedResumeMemory \} from '\.\.\/\.\.\/utils\/feedResumeMemory\.js';/);
  assert.match(code, /const resumeMemory = createFeedResumeMemory\(\);/, 'one memory, at module scope, shared by every surface');
  assert.doesNotMatch(code, /savedScrollByKey|savedIndexByKey|savedPaperIdByKey/, 'the three bare maps are gone');

  const handler = bounded(code, 'const handleScroll = useCallback(', '}, [schedulePendingSkipFlush, scrollKey]);', 'the scroll handler', 30);
  assert.match(handler, /resumeMemory\.remember\(scrollKey, \{/, 'every scroll event updates the memory');
  assert.match(handler, /scrollIdleTimerRef\.current = setTimeout\(\(\) => \{[\s\S]*?resumeMemory\.persist\(scrollKey\);[\s\S]*?\}, SCROLL_IDLE_DELAY_MS\);/,
    'and the storage write waits for the scroll to settle');
  assert.match(code, /return \(\) => \{[\s\S]{0,300}resumeMemory\.persist\(scrollKey\);[\s\S]{0,120}\}, \[scrollKey\]\);/, 'leaving the feed persists the place it was left at');
});

test('SOURCE: the resumed card is looked up in the memory, for the mount window and for the restore', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const restore = bounded(code, 'const restoreAttemptedRef = useRef(false);', '}, [papers, scrollKey]);', 'the restore effect', 30);
  assert.match(restore, /const saved = resumeMemory\.get\(scrollKey\);/);
  assert.match(restore, /saved\.scrollTop > 0 \|\| saved\.index > 0/, 'a place restored from storage has an index and no pixel offset');
  assert.match(restore, /resumeIndex\(\{ papers, savedPaperId: saved\.paperId, savedIndex: saved\.index \}\)/);
});

test('SOURCE: the profile and settings screens are warmed at idle, so a deploy does not force a reload on the way there', async () => {
  const code = stripComments(await read('../../App.jsx'));
  const block = bounded(code, 'const prefetch = () => {', 'const schedule = window.requestIdleCallback', 'the idle prefetch', 40);
  assert.match(block, /PublicProfilePage\.preload\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(block, /SettingsPage\.preload\(\)\.catch\(\(\) => \{\}\)/);
});
