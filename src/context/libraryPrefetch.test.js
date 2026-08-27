import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CURATED_SETS } from '../utils/interactionProfile.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * One read at mount, used by every list — the contract that spans two files.
 *
 * Opening a list used to go out for the metadata of every paper it held, one
 * click at a time, over the same connection the mount was already using. The
 * documents were mostly already paid for: `ensurePersonalLibrary` fetched the
 * curated ids and then kept only the records carrying read / readLater / a note
 * / tags, decoding and discarding the rest. Favorites was worse than that — the
 * liked ids were not even in the fetch set, so the largest list in the app was
 * the one with nothing pre-warmed at all.
 *
 * These are SOURCE tests because the behaviour lives in a React context and a
 * component, and this repo has no way to render either. They are coarse on
 * purpose: they pin the shape of the contract, not its implementation.
 */

test('the library read asks for every curated set a list can be built from', async () => {
  const source = await read('./FeedContext.jsx');
  const union = source.slice(
    source.indexOf('const paperIds = [...new Set(['),
    source.indexOf('PERSONAL_LIBRARY_MAX_RECORDS)'),
  );
  assert.ok(union.length > 0, 'expected to have found the id union');

  // `notInterested` is the one curated set no list is ever built from.
  for (const name of CURATED_SETS.filter(entry => entry !== 'notInterested')) {
    assert.match(union, new RegExp(`curatedIds\\(profile, '${name}'\\)`),
      `'${name}' feeds a list the owner can open, so the mount must fetch it`);
  }
});

test('what the read fetches is kept, even when the record is filtered out', async () => {
  const source = await read('./FeedContext.jsx');

  const forEachBody = source.slice(
    source.indexOf('records.forEach(({ id, data }) => {'),
    source.indexOf('setPersonalLibrary(current =>'),
  );
  assert.ok(forEachBody.length > 0, 'expected to have found the record loop');

  // The filter still guards `personalLibrary` — its meaning has not changed —
  // but the paper must be stored BEFORE the early return, or the metadata this
  // read paid for is thrown away and bought again a click later.
  const filterAt = forEachBody.indexOf('data.read || data.readLater || data.note');
  const keepAt = forEachBody.indexOf('papers[id] = paper');
  assert.ok(filterAt > 0, 'the reading-library filter must stay');
  assert.ok(keepAt > 0, 'the fetched paper must be kept');
  assert.ok(keepAt < filterAt,
    'the paper is kept before the filter returns, or a liked-only paper is discarded');

  assert.match(source, /setLibraryPapers\(/, 'the kept papers must reach state');
  assert.match(source, /^\s*libraryPapers,$/m, 'and be exposed on the context');
});

test('the lists screen counts the prefetch as already in hand', async () => {
  const source = await read('../components/Lists/ListsPage.jsx');

  assert.match(source, /^\s*libraryPapers,$/m, 'it must take the prefetch from the context');

  // The decision that turns the prefetch into fewer round trips: a paper the
  // mount already fetched must not be counted as missing.
  const missing = source.slice(
    source.indexOf('const missingIds = paperIds.filter('),
    source.indexOf('// Whatever the last list left waiting'),
  );
  assert.ok(missing.length > 0, 'expected to have found the missing-id filter');
  assert.match(missing, /!libraryPapers\[paperId\]/,
    'a paper the mount already fetched is not missing, and must not be re-read');
});

/**
 * The lie this screen kept finding new ways to tell: rendering "we could not
 * find out yet" as "there is nothing here". It has appeared as a raw arXiv id
 * under a row, as an empty account with lists, and — this one — as a card
 * announcing a list of forty-six papers to be empty because no title had
 * arrived yet.
 */
test('an empty card means an empty list, not an unfinished read', async () => {
  const source = await read('../components/Lists/ListsPage.jsx');
  const preview = source.slice(
    source.indexOf('<div className="list-card-preview">'),
    source.indexOf('list-card-preview-title'),
  );
  assert.ok(preview.length > 0, 'expected to have found the card preview');
  assert.match(preview, /paperIds\?\.length \?\? 0\) === 0/,
    'the empty state must key off the list, never off what has been fetched');
});

/* --- The profile's Liked tab, on the same read ---------------------------- */

test('the Liked tab counts the prefetch as already in hand', async () => {
  const source = await read('../components/Public/PublicProfilePage.jsx');

  assert.match(source, /libraryPapers,/, 'it must take the prefetch from the context');

  // The second fan-out over the same collection only survives for ids the
  // mount did not bring back. In the ordinary case that list is empty.
  const wanted = source.slice(
    source.indexOf('const wanted = likedOrder.filter('),
    source.indexOf('if (wanted.length === 0)'),
  );
  assert.ok(wanted.length > 0, 'expected to have found the liked-id filter');
  assert.match(wanted, /!libraryPapers\[id\]/,
    'a liked paper the mount already fetched must not be fetched a second time');

  assert.match(source, /libraryPapers\[id\] \|\| extra\?\.paper/,
    'and the row must render from it');
});

/**
 * Fifty rows reading "Untitled paper" is fifty statements of a fact nobody
 * established. A paper always has a title; not having one means the read has
 * not answered, and that is a different thing to say.
 */
test('a row with no title says so, rather than inventing a title for it', async () => {
  const source = await read('../components/Public/PublicProfilePage.jsx');

  // Comments stripped first. That file's comments explain this very fix and
  // name the string they removed, which is not the same as still shipping it —
  // a check that cannot tell those apart would forbid writing down the reason.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.ok(!/untitled:/.test(code), 'the copy key is gone, not merely unused');
  assert.ok(!/Untitled paper/.test(code), 'and so is the string it held');
  assert.ok(!/Paper sin t[ií]tulo/.test(code), 'in both languages');

  assert.match(source, /unresolved: !title/, 'the row must carry the distinction');
  assert.match(source, /if \(row\.unresolved\)/, 'and PaperRow must act on it');
  // Waiting and answered-with-nothing are different states and look different:
  // a shimmer while the read is out, the id itself once it is not.
  assert.match(source, /libraryReady\s*\n?\s*\?\s*<span className="profile-row-title profile-row-title--placeholder">/,
    'once the read has answered, the id is what there is to show');
});
