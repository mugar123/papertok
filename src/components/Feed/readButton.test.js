import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * Marking a paper read used to fade the card out and pull it from the feed
 * a second and a half later. The paper stays; the eye becomes the tick.
 */
test('SOURCE: marking a paper read keeps it in the feed', async () => {
  const context = stripComments(await read('../../context/FeedContext.jsx'));
  const body = context.slice(context.indexOf('const markAsRead = useCallback('), context.indexOf('const trackViewTime = useCallback('));
  assert.doesNotMatch(body, /setPapers\(/, 'the card is not removed from the feed when it is marked read');
  const card = stripComments(await read('./PaperCard.jsx'));
  assert.doesNotMatch(card, /isMarkingRead|pc--fade-out/, 'no fade-out, no delayed unmount');
  assert.match(card, /if \(isRead\) return;\s*onMarkAsRead\(paper\);/, 'the mark lands at once, and only once');
});

test('SOURCE: the eye and the tick share the slot so one can turn into the other', async () => {
  const card = await read('./PaperCard.jsx');
  assert.match(card, /<Eye size=\{20\} className="pc-icon-eye" aria-hidden="true" \/>\s*<CheckCircle2 size=\{20\} className="pc-icon-check" aria-hidden="true" \/>/);
  assert.match(card, /aria-pressed=\{isReadActive\}/);
  const css = await read('./PaperCard.css');
  assert.match(css, /\.pc-side-btn--read \.pc-side-icon--morph \.pc-icon-eye \{[\s\S]*?opacity: 0;[\s\S]*?transform: scale\(0\.5\) rotate\(20deg\);/);
  assert.match(css, /\.pc-side-btn--read \.pc-side-icon--morph \.pc-icon-check \{[\s\S]*?opacity: 1;[\s\S]*?transform: none;/);
  assert.match(css, /cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/, 'the tick overshoots and settles');
  assert.doesNotMatch(css, /\.pc--fade-out/);
});

test('SOURCE: a stored copy from a list or a profile row opens on the skeleton', async () => {
  const lists = await read('../Lists/ListsPage.jsx');
  assert.match(lists, /navigate\(path, \{ state: \{ paper, stored: true \} \}\)/);
  const profile = await read('../Public/PublicProfilePage.jsx');
  assert.match(profile, /state=\{row\.seed \? \{ paper: row\.seed, stored: true \} : undefined\}/);
  const palette = await read('../../utils/searchDestinations.js');
  assert.match(palette, /state: \{ paper \}/, 'the palette hands over the paper itself, which does paint');
});
