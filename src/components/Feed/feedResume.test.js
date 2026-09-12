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

  const handler = bounded(code, 'const handleScroll = useCallback(', '}, [reportVisiblePaper, schedulePendingSkipFlush, scrollKey]);', 'the scroll handler', 32);
  assert.match(handler, /resumeMemory\.remember\(scrollKey, \{/, 'every scroll event updates the memory');
  assert.match(handler, /scrollIdleTimerRef\.current = setTimeout\(\(\) => \{[\s\S]*?resumeMemory\.persist\(scrollKey\);[\s\S]*?\}, SCROLL_IDLE_DELAY_MS\);/,
    'and the storage write waits for the scroll to settle');
  assert.match(code, /return \(\) => \{[\s\S]{0,300}resumeMemory\.persist\(scrollKey\);[\s\S]{0,120}\}, \[scrollKey[^\]]*\]\);/, 'leaving the feed persists the place it was left at');
});

test('SOURCE: the resumed card is looked up in the memory, for the mount window and for the restore', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const restore = bounded(code, 'const restoreAttemptedRef = useRef(false);', '}, [papers, reportVisiblePaper, scrollKey]);', 'the restore effect', 32);
  assert.match(restore, /const saved = resumeMemory\.get\(scrollKey\);/);
  assert.match(restore, /saved\.scrollTop > 0 \|\| saved\.index > 0/, 'a place restored from storage has an index and no pixel offset');
  assert.match(restore, /resumeIndex\(\{ papers, savedPaperId: saved\.paperId, savedIndex: saved\.index \}\)/);
});

/**
 * The card the container calls active on the FIRST painted frame.
 *
 * `activeIndex` was seeded to a bare 0 and only ever corrected inside
 * `handleScroll`, which runs in a later task than the `useLayoutEffect` that
 * assigns `scrollTop`. With `MOUNT_WINDOW_RESUME_RADIUS` at 0 the only card
 * mounted at that first frame is the resumed one, and a 0 here gave it
 * `data-active="false"`: it painted complete, and the moment the scroll event
 * landed its title, meta, authors, abstract and action bar blanked out and
 * faded back in over 280ms plus 175ms of stagger (PaperCard.css `pcArrive`
 * starts from `opacity: 0`). The seed is the same anchor the mount window
 * takes, and the restore effect re-seeds it for the other resume shape — a
 * reload, whose papers have not arrived when the component first renders.
 */
test('SOURCE: activeIndex is seeded from the resume anchor, not from a bare 0', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  assert.match(
    code,
    /function resumeAnchor\(papers, scrollKey\) \{\s*const saved = resumeMemory\.get\(scrollKey\);\s*return \{ saved, index: resumeIndex\(\{ papers, savedPaperId: saved\.paperId, savedIndex: saved\.index \}\) \};\s*\}/,
    'one helper answers where the feed opens, by paper id first and the saved index only as a fallback',
  );
  assert.match(
    code,
    /const \[activeIndex, setActiveIndex\] = useState\(\(\) => resumeAnchor\(papers, scrollKey\)\.index\);/,
    'the seed is the resume anchor',
  );
  assert.doesNotMatch(code, /useState\(0\)/, 'no bare 0 seed may come back');
  // The mount window and the seed must take the SAME anchor: a window on
  // card N with activeIndex 0 is the defect, whichever of the two is wrong.
  assert.match(code, /const \{ saved, index \} = resumeAnchor\(papers, scrollKey\);\s*return initialMountWindow\(\{\s*total: papers\.length,\s*anchorIndex: index,/);

  // The reload shape: papers arrive after the first render, so the seed above
  // could only answer 0. A layout effect flushes its re-render before the
  // browser paints, so the resumed card still never shows a frame at rest.
  const restore = bounded(code, 'const restoreAttemptedRef = useRef(false);', '}, [papers, reportVisiblePaper, scrollKey]);', 'the restore effect', 40);
  assert.match(
    restore,
    /reportVisiblePaper\?\.\(papers\[index\]\?\.id \?\? null\);\s*setActiveIndex\(index\);/,
    'the restore re-seeds activeIndex with the index it has already computed',
  );
  assert.match(code, /useLayoutEffect\(\(\) => \{\s*if \(restoreAttemptedRef\.current/, 'and it must stay a LAYOUT effect, or the re-render lands after a paint');
});

test('SOURCE: the profile and settings screens are warmed at idle, so a deploy does not force a reload on the way there', async () => {
  const code = stripComments(await read('../../App.jsx'));
  const block = bounded(code, 'const prefetch = () => {', 'const schedule = window.requestIdleCallback', 'the idle prefetch', 40);
  assert.match(block, /PublicProfilePage\.preload\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(block, /SettingsPage\.preload\(\)\.catch\(\(\) => \{\}\)/);
});

/**
 * The feed's re-rank locks the cards through the one the reader is on, so
 * the container has to say which one that is: on the restore after a reload
 * (before any scroll event, which the programmatic scrollTop only fires
 * asynchronously) and on every scroll. Only the For You feed reports — the
 * Following and guest surfaces render lists the context does not own.
 */
test('SOURCE: the container reports the visible paper to the feed context, on restore and on scroll', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  assert.match(code, /const reportVisiblePaper = source \? null : feed\.reportVisiblePaper;/,
    'a surface with its own source never reports into For You');

  const restore = bounded(code, 'const restoreAttemptedRef = useRef(false);', '}, [papers, reportVisiblePaper, scrollKey]);', 'the restore effect', 32);
  assert.match(restore, /const index = resumeIndex\(\{ papers, savedPaperId: saved\.paperId, savedIndex: saved\.index \}\);\s*reportVisiblePaper\?\.\(papers\[index\]\?\.id \?\? null\);/,
    'the resumed card is reported as soon as it is known, whether or not there is somewhere to scroll to');

  const handler = bounded(code, 'const handleScroll = useCallback(', '}, [reportVisiblePaper, schedulePendingSkipFlush, scrollKey]);', 'the scroll handler', 32);
  assert.match(handler, /const paperId = papersRef\.current\[index\]\?\.id \|\| resumeMemory\.get\(scrollKey\)\.paperId;/);
  assert.match(handler, /resumeMemory\.remember\(scrollKey, \{\s*scrollTop: container\.scrollTop,\s*index,\s*paperId,\s*\}\);\s*reportVisiblePaper\?\.\(paperId\);/,
    'the same id goes to the resume memory and to the context');
});
