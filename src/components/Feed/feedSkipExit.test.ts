import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { skipExitSlot, SKIP_EXIT_MS } from '../../utils/feedSkipExit.ts';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code: string, from: string, to: string, label: string, maxLines: number) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  assert.ok(block.split('\n').length <= maxLines, `${label} capture spans past what it names`);
  return block;
}

/**
 * Every snap item is exactly one container tall (`height: 100%` plus
 * `contain-intrinsic-size: 0 100%`), so the slot a card occupies is its index
 * times that height — no DOM read, and no id escaping for the paper ids that
 * carry slashes and colons.
 */
test('the slot a leaving card occupies is its index times the card height', () => {
  const papers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(skipExitSlot({ papers, paperId: 'a', cardHeight: 700 }), { id: 'a', top: 0, height: 700 });
  assert.deepEqual(skipExitSlot({ papers, paperId: 'c', cardHeight: 700 }), { id: 'c', top: 1400, height: 700 });
});

/**
 * Null means "there is nothing to animate": the caller removes the card
 * straight away, exactly as it did before this existed. A skip must never be
 * swallowed because the geometry could not be worked out.
 */
test('a slot that cannot be worked out is null, not a guess', () => {
  const papers = [{ id: 'a' }, { id: 'b' }];
  assert.equal(skipExitSlot({ papers, paperId: 'zzz', cardHeight: 700 }), null, 'an id that is not in the list');
  assert.equal(skipExitSlot({ papers, paperId: '', cardHeight: 700 }), null);
  assert.equal(skipExitSlot({ papers, paperId: null, cardHeight: 700 }), null);
  assert.equal(skipExitSlot({ papers, paperId: 'a', cardHeight: 0 }), null, 'a container that has not been measured');
  assert.equal(skipExitSlot({ papers, paperId: 'a', cardHeight: NaN }), null);
  assert.equal(skipExitSlot({ papers: null!, paperId: 'a', cardHeight: 700 }), null);
});

test('the exit is short enough to stay out of the way', () => {
  assert.ok(SKIP_EXIT_MS > 0 && SKIP_EXIT_MS <= 300,
    'a UI exit over 300ms reads as sluggish; this one has no reason to be long');
});

test('SOURCE: the skip runs the card out before removing it', async () => {
  const code = stripComments(await read('./FeedContainer.tsx'));

  const signedIn = bounded(code, 'const handleNotInterested = useCallback(', '}, [', 'handleNotInterested', 14);
  assert.match(signedIn, /beginSkipExit\(/, 'the signed-in skip starts the exit');
  assert.match(signedIn, /markNotInterested\(paper\)/, 'and its commit is the real removal');

  assert.match(code, /onNotInterested=\{handleNotInterested\}/);
});

/**
 * "Not interested" says so in a toast with an Undo. Undo during the exit
 * drops the removal that has not happened yet; after it, the paper is put
 * back where the reader is, and comes in from the side it left by.
 */
test('SOURCE: Not interested can be undone, and the paper comes back', async () => {
  const code = stripComments(await read('./FeedContainer.tsx'));
  const press = bounded(code, 'const handleNotInterested = useCallback(', '}, [', 'handleNotInterested', 14);
  assert.match(press, /toast\('Marked as not interested', \{\s*action: \{ label: 'Undo', onClick: \(\) => handleUndoNotInterested\(paper\) \}/);
  const undo = bounded(code, 'const handleUndoNotInterested = useCallback(', '}, [', 'handleUndoNotInterested', 26);
  assert.match(undo, /setReturning\(returningRef\.current\)/, 'the card is marked as coming back');
  assert.doesNotMatch(undo, /setTimeout\(landReturn/,
    'the backstop does not start on the press: the card mounts first, and a clock started here landed it mid-travel');
  assert.match(code, /if \(!returning \|\| returning\.landed\) return undefined;\s*const timer = setTimeout\(landReturn, SKIP_RETURN_MS \+ \d+\);/,
    'it starts with the commit that pins the card, and only backs up animationend');
  assert.match(undo, /if \(skipExitRef\.current\?\.id === paper\.id\) \{[\s\S]*?setSkipExit\(null\);\s*return;/, 'a running exit is dropped, never committed');
  assert.match(undo, /undoNotInterested\(paper, source \? null : Math\.round\(container\.scrollTop \/ height\)\)/, 'a landed removal is taken back at the reader\'s slot');
  assert.match(code, /returning\?\.id === paper\.id && !returning\.landed \? \{ top: `\$\{index \* returning\.height\}px`/, 'pinned over its slot while it travels');
  const css = await read('./FeedContainer.css');
  assert.match(css, /\.feed-snap-item--leaving,\n\.feed-snap-item--returning \{\s*position: absolute;/, 'out of flow, over the card it covers, like the exit');
  assert.match(css, /@keyframes feedSkipReturn \{\s*from \{ transform: translateX\(105%\)/, 'it comes back from the right, the side it left by');
  assert.doesNotMatch(stripComments(css).slice(css.indexOf('.feed-snap-item--returning > .pc {')).split('}')[0], /feedSkipReturnFade/,
    'with movement it covers the card opaque, without fading in from nothing');
  assert.match(css, /\.feed-snap-item--returned :is\([^)]*\.pc-title[^)]*\) \{\s*animation: none;/, 'it comes back whole, without replaying the arrival');
  assert.match(css, /\.feed-snap-item--returned > \.pc \{\s*transition-property: opacity, translate;\s*\}/,
    'no transform transition on the returned card: WebKit fires it as the return comes off and the card lurches right');
});

/**
 * The removal is deferred by the length of the exit, so it needs the two
 * escapes every deferred commit in this file already has: the animation
 * ending, and a clock in case it never runs (a `prefers-reduced-motion` rule
 * that turns the animation off would otherwise strand the card forever).
 */
test('SOURCE: the deferred removal cannot be stranded', async () => {
  const code = stripComments(await read('./FeedContainer.tsx'));
  const block = bounded(code, 'const beginSkipExit = useCallback(', '}, [', 'beginSkipExit', 30);

  assert.match(block, /setTimeout\(/, 'a clock backs the animation up');
  assert.match(block, /SKIP_EXIT_MS/, 'and it is derived from the exit, not from a second literal');
  assert.match(block, /commit\(\)/, 'a card with no slot to animate is removed at once');

  assert.match(code, /animationName\)\.startsWith\(['"]feedSkipExit['"]\)/,
    'the animationend listener names the exit: the card is full of other animations that bubble');

  // Unmounting mid-exit must not eat the interaction, the same rule the
  // pending-skip flush in the same cleanup already follows.
  const cleanup = bounded(code, 'useEffect(() => {\n    return () => {', '}, [scrollKey, flushSkipExit]);', 'unmount cleanup', 12);
  assert.match(cleanup, /flushSkipExit\(\)/, 'leaving the feed mid-exit still commits the skip');
});

test('SOURCE: the exit moves nothing but transform and opacity', async () => {
  const css = await read('./FeedContainer.css');

  // Two animations, because the travel and the fade want different curves:
  // the house expo spends most of the distance early, and an expo on an
  // opacity is a flash with a tail rather than a fade.
  const travel = bounded(css, '@keyframes feedSkipExit {', '}\n}', 'the travel keyframes', 8);
  assert.match(travel, /transform:\s*translateX/, 'it travels sideways');
  assert.doesNotMatch(travel, /\b(width|height|margin|padding|top|left|right|bottom|opacity)\s*:/,
    'anything but transform here puts layout and paint back in the frame budget');

  const fade = bounded(css, '@keyframes feedSkipExitFade {', '}\n}', 'the fade keyframes', 8);
  assert.match(fade, /opacity:\s*0/, 'and it retires');
  assert.doesNotMatch(fade, /\b(width|height|margin|padding|top|left|right|bottom|transform)\s*:/);

  const leaving = bounded(stripComments(css), '.feed-snap-item--leaving,\n.feed-snap-item--returning {', '}', 'the leaving item rule', 16);
  assert.match(leaving, /position:\s*absolute/, 'out of flow, so the next card takes the slot in the same frame');
  assert.match(leaving, /scroll-snap-align:\s*none/, 'a card on its way out is not a place to stop');
  assert.match(leaving, /pointer-events:\s*none/, 'and it cannot be tapped on its way out');
  // The slot clips and the card inside it travels. The other way round hangs
  // the card off a scroller whose x axis cannot be `clip`, and leaves it
  // scrollable sideways for the length of the exit.
  assert.match(leaving, /overflow:\s*hidden/, 'the slot clips its own card');
  assert.doesNotMatch(leaving, /animation:/, 'and the slot itself does not move');

  const travelling = bounded(stripComments(css), '.feed-snap-item--leaving > .pc {', '}', 'the travelling card', 8);
  assert.match(travelling, /var\(--ease-out-[a-z]+\)/,
    'a house curve, not a fourth hand-rolled cubic-bezier');
  // Measured: on `--ease-out-expo` the card was 74% gone inside three frames
  // and invisible as motion. Expo brakes at the end, and the end of a
  // departure is off-screen.
  assert.doesNotMatch(travelling, /var\(--ease-out-expo\)/,
    'expo front-loads the distance, which is what made the first cut a flash');
  assert.match(travelling, /feedSkipExitFade[^;]*linear/,
    'the fade is linear: an expo on an opacity is a flash, not a fade');
  // One duration, two files. A CSS that drifts from the constant would defer
  // the removal past the exit, or cut the exit off before it finished.
  assert.match(travelling, new RegExp(`feedSkipExit ${SKIP_EXIT_MS}ms`),
    'the travel lasts exactly SKIP_EXIT_MS, which is what the removal waits for');

  // The travel goes rightwards past the card's own width, so without this the
  // scroller grows a horizontal axis under it.
  const container = bounded(stripComments(css), '.feed-container {', '}', '.feed-container', 20);
  assert.match(container, /overflow-x:\s*(hidden|clip)/, 'the exit must not widen the scroller');
  assert.match(container, /position:\s*relative/, 'the leaving card is positioned against the scrolled content');
});

/**
 * Reduced motion keeps the removal legible — the card still goes, and still
 * takes a moment doing it — and gives up the travel. Not zero: a card that
 * teleports is the very thing this animation was added to fix.
 */
test('SOURCE: reduced motion drops the travel and keeps the fade', async () => {
  const css = await read('./FeedContainer.css');
  const reduced = bounded(
    css,
    '@media (prefers-reduced-motion: reduce) {\n  .feed-snap-item--leaving > .pc',
    '}\n}',
    'the reduced-motion exit',
    8,
  );
  assert.match(reduced, /animation:\s*feedSkipExitFade/, 'the fade alone still says the card went');
  assert.doesNotMatch(reduced, /feedSkipExit /, 'and the travel is gone');

  const fade = bounded(css, '@keyframes feedSkipExitFade {', '}\n}', 'the fade keyframes', 8);
  assert.doesNotMatch(fade, /translate|scale/, 'nothing travels and nothing resizes');
});
