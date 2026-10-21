import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * Marking a paper read used to fade the card out and pull it from the feed
 * a second and a half later. The paper stays; the eye becomes the tick.
 */
test('SOURCE: marking a paper read keeps it in the feed', async () => {
  const context = stripComments(await read('../../context/FeedContext.tsx'));
  const body = context.slice(context.indexOf('const markAsRead = useCallback('), context.indexOf('const trackViewTime = useCallback('));
  assert.doesNotMatch(body, /setPapers\(/, 'the card is not removed from the feed when it is marked read');
  const card = stripComments(await read('./PaperCard.tsx'));
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
  const card = stripComments(await read('./PaperCard.tsx'));
  assert.match(card, /onUnmarkAsRead = \(\) => \{\},/, 'the prop has a safe default');
  assert.match(card, /if \(isRead\) \{\s*onUnmarkAsRead\(paper\.id\);\s*return;\s*\}/, 'a second press takes the mark back');
  assert.match(card, /onUnmarkAsRead=\{onUnmarkAsRead\}/, 'the related-paper card gets it too');
  const mounts = [
    ['../Feed/FeedContainer.tsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Search/SearchPage.tsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Explorer/EntityExplorer.tsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Public/PublicPaperPage.tsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Lists/ListsPage.tsx', /onUnmarkAsRead=\{forgetRead\}/],
  ] as const;
  for (const [path, pattern] of mounts) {
    assert.match(await read(path), pattern, `${path} hands the card the way back`);
  }
  const lists = stripComments(await read('../Lists/ListsPage.tsx'));
  assert.match(lists, /const forgetRead = \(paperId: string\) => \{\s*unmarkAsRead\(paperId\);[\s\S]*?'__read__'/,
    'on the lists page the row also leaves the reading list');
});

/**
 * In the feed, "Mark as read" moves the reader on to the next paper and says
 * so, with a way back: Undo takes the mark back and returns to the paper.
 * A visitor, whose mark is not kept, gets neither.
 */
test('SOURCE: marking a paper read in the feed moves on, with an Undo', async () => {
  const feed = stripComments(await read('./FeedContainer.tsx'));
  assert.match(feed, /onMarkAsRead=\{handleMarkAsRead\}/, 'the feed hands the card its own handler');
  const body = feed.slice(feed.indexOf('const handleMarkAsRead = useCallback('), feed.indexOf('}, [markAsRead,'));
  assert.match(body, /void markAsRead\(paper\);\s*if \(!user\) return;/, 'the mark lands first; a visitor stops there');
  assert.match(body, /scrollToCard\(index \+ 1\)/, 'the feed moves to the next paper');
  assert.match(body, /toast\('Marked as read', \{\s*action: \{\s*label: 'Undo'/, 'the reader is told, with an Undo');
  assert.match(body, /onClick: \(\) => \{[\s\S]*?unmarkAsRead\(paper\.id\)[\s\S]*?scrollToCard\(at\)/, 'Undo takes the mark back and returns to the paper');
});

test('SOURCE: a stored copy from a list opens on the skeleton', async () => {
  const lists = await read('../Lists/ListsPage.tsx');
  assert.match(lists, /navigate\(path, \{ state: \{ paper, stored: true, pageMotion: 'still' \} \}\)/);
  const palette = await read('../../utils/searchDestinations.ts');
  assert.match(palette, /state: \{ paper \}/, 'the palette hands over the paper itself, which does paint');
});

test('SOURCE: la acción de leído dice «Mark as read»/«Mark as unread», nunca la acción de abrir', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  // In the rail's More panel (PaperMenu): the item says what it will do.
  const item = card.slice(card.indexOf("id: 'read'"), card.indexOf("id: 'skip'"));
  assert.doesNotMatch(item, /Read article|Open version|Open source/);
  assert.match(item, /label: isReadActive \? 'Mark as unread' : 'Mark as read'/);
});
