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
  assert.match(card, /if \(isRead\) \{\s*onUnmarkAsRead\(paper\.id\);[\s\S]*?return;\s*\}\s*onMarkAsRead\(paper\);/,
    'the mark lands at once; a second press takes it back instead of landing again');
});

/**
 * The read button is a toggle. Pressing it on a read paper takes the mark
 * back: the tick folds away first, the eye springs back a beat later, and the
 * slot dips as its teal fill drains. Every surface that mounts a card hands
 * it the way back, not only the way in.
 */
test('SOURCE: every card mount can take a read mark back', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
  assert.match(card, /onUnmarkAsRead = \(\) => \{\},/, 'the prop has a safe default');
  assert.match(card, /if \(isRead\) \{\s*onUnmarkAsRead\(paper\.id\);\s*return;\s*\}/, 'a second press takes the mark back');
  assert.match(card, /onUnmarkAsRead=\{onUnmarkAsRead\}/, 'the related-paper card gets it too');
  const mounts = [
    ['../Feed/FeedContainer.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Search/SearchPage.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Explorer/EntityExplorer.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Public/PublicPaperPage.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Lists/ListsPage.jsx', /onUnmarkAsRead=\{forgetRead\}/],
  ];
  for (const [path, pattern] of mounts) {
    assert.match(await read(path), pattern, `${path} hands the card the way back`);
  }
  const lists = stripComments(await read('../Lists/ListsPage.jsx'));
  assert.match(lists, /const forgetRead = \(paperId\) => \{\s*unmarkAsRead\(paperId\);[\s\S]*?'__read__'/,
    'on the lists page the row also leaves the reading list');
});

test('SOURCE: a stored copy from a list opens on the skeleton', async () => {
  const lists = await read('../Lists/ListsPage.jsx');
  assert.match(lists, /navigate\(path, \{ state: \{ paper, stored: true \} \}\)/);
  const palette = await read('../../utils/searchDestinations.js');
  assert.match(palette, /state: \{ paper \}/, 'the palette hands over the paper itself, which does paint');
});

test('SOURCE: la acción de leído dice «Mark as read»/«Mark as unread», nunca la acción de abrir', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
  // In the rail's More menu (MoreActions): the item says what it will do.
  const item = card.slice(card.indexOf("id: 'read'"), card.indexOf("id: 'skip'"));
  assert.doesNotMatch(item, /Read article|Open version|Open source/);
  assert.match(item, /label: isReadActive \? 'Mark as unread' : 'Mark as read'/);
});
