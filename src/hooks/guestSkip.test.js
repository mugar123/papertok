import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dropPaperById } from './useGuestFeed.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * A visitor without an account pressed Skip and got a sign-in prompt instead of
 * the paper going away. The guest feed's papers live in React state, so the
 * removal costs nothing and needs no account.
 */
test('dropPaperById removes exactly the paper asked for', () => {
  const papers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const next = dropPaperById(papers, 'b');
  assert.deepEqual(next.map((p) => p.id), ['a', 'c']);
  assert.notEqual(next, papers, 'a new array, so React sees the change');
});

test('dropPaperById leaves the list untouched for an id that is not there', () => {
  const papers = [{ id: 'a' }, { id: 'b' }];
  assert.equal(dropPaperById(papers, 'zzz'), papers, 'same reference: no re-render for nothing');
  assert.equal(dropPaperById(papers, ''), papers);
  assert.equal(dropPaperById(papers, null), papers);
  assert.equal(dropPaperById(papers, undefined), papers);
});

test('dropPaperById survives a list that is not a list', () => {
  assert.deepEqual(dropPaperById(null, 'a'), []);
  assert.deepEqual(dropPaperById(undefined, 'a'), []);
});

/**
 * The guest skip must never reach the network. `useGuestFeed` is the only place
 * that could take it there, so the removal path stays inside setState.
 */
test('SOURCE: the guest dismissal only touches React state', async () => {
  const src = stripComments(await read('./useGuestFeed.js'));
  const start = src.indexOf('const dismissPaper = useCallback(');
  assert.ok(start > -1, 'useGuestFeed exposes a dismissPaper');
  const body = src.slice(start, src.indexOf('}, [', start));
  assert.match(body, /setPapers\(/, 'it removes the paper from the shown list');
  assert.doesNotMatch(body, /fetch|await|firestore|setDoc|updateDoc|localStorage|sessionStorage/i,
    'nothing here reaches the network or any store that outlives the page');
  assert.match(src, /return \{[\s\S]*?dismissPaper,[\s\S]*?\};/, 'and the hook hands it to its caller');
});

/**
 * Only a surface that keeps its own list can drop a paper for a visitor. A
 * page showing one paper has nothing to drop, so it still asks for the account.
 */
test('SOURCE: Skip without an account is opt-in, per surface', async () => {
  const card = stripComments(await read('../components/Feed/PaperCard.jsx'));
  const start = card.indexOf('const handleNotInterested = (e) => {');
  const body = card.slice(start, card.indexOf('};', start));
  assert.match(body, /if \(publicMode\) \{[\s\S]{0,200}?if \(onGuestNotInterested\) \{[\s\S]{0,120}?onGuestNotInterested\(paper\?\.id\);[\s\S]{0,60}?return;[\s\S]{0,40}?\}[\s\S]{0,60}?requireAuthentication\('not_interested'\);/,
    'a surface that supplies a guest handler uses it; one that does not still asks for the account');
  assert.match(body, /onGuestNotInterested\(paper\?\.id\)/,
    'it hands over the id, which is what the guest feed removes by');
  assert.doesNotMatch(card, /onGuestNotInterested = \(\) => \{\}/,
    'no default, or every surface would look guest-capable');

  const container = stripComments(await read('../components/Feed/FeedContainer.jsx'));
  // The prop is the surface's own dismissal, now wrapped so the card runs out
  // of the feed before it is dropped (utils/feedSkipExit.js). What must not
  // change is that it is CONDITIONAL on the surface having a list of its own:
  // handing one over unconditionally would offer Skip on every public surface,
  // including the ones with nothing to remove it from.
  assert.match(container, /const dismissFromSource = source\?\.onNotInterested;/,
    'the guest handler still comes from the surface that owns the list');
  assert.match(container, /onGuestNotInterested=\{dismissFromSource \? handleGuestNotInterested : undefined\}/,
    'and a surface that supplies none is still handed nothing');
  const wrapper = stripComments(container).match(/const handleGuestNotInterested = useCallback\([\s\S]{0,200}?\}, \[/)?.[0];
  assert.ok(wrapper, 'expected the wrapper around the surface dismissal');
  assert.match(wrapper, /dismissFromSource\?\.\(paperId\)/, 'which ends in the surface dropping the paper by id');

  const guest = stripComments(await read('../components/Public/GuestFeedPage.jsx'));
  assert.match(guest, /onNotInterested: guestFeed\.dismissPaper/,
    'and the guest feed is the surface that supplies it');
});

/**
 * Skipping trains the recommender. A visitor has no profile to train, so the
 * analytics half stays off even though the card now goes away.
 */
test('SOURCE: a guest skip still records nothing', async () => {
  const container = stripComments(await read('../components/Feed/FeedContainer.jsx'));
  const start = container.indexOf('const handleSkip = useCallback(');
  const body = container.slice(start, container.indexOf('}, [', start));
  assert.match(body, /if \(publicMode\) return;/, 'the analytics path is still closed for a visitor');
});

/**
 * The related-paper overlay reuses PaperCard but is not the guest feed, so it
 * must not inherit the guest skip.
 */
test('SOURCE: the related-paper overlay does not forward the guest skip', async () => {
  const card = stripComments(await read('../components/Feed/PaperCard.jsx'));
  const nested = card.slice(card.indexOf('paper={selectedRelatedPaper}'));
  const props = nested.slice(0, nested.indexOf('/>'));
  assert.doesNotMatch(props, /onGuestNotInterested/,
    'the overlay keeps asking for an account');
});
