import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OWN_LISTS_FRESH_MS,
  forgetOwnLists,
  ownListsAreFresh,
  ownListsCache,
  readListPapers,
  rememberListPapers,
  rememberOwnLists,
  rememberSavedAnswers,
  reviseOwnLists,
  savedAnswered,
  savedDocumentRead,
} from './profile-session-caches.ts';

/**
 * The freshness window on the lists read. Saving fifty papers in a row opened
 * the save modal fifty times and re-read all sixty list documents each time,
 * which is what saturated into an endless skeleton.
 */

test('a lists read just taken is fresh, and an unknown account never is', () => {
  const now = 1_000_000;
  rememberOwnLists('uid-a', [{ id: 'l1', paperIds: [] }]);
  assert.equal(ownListsAreFresh('uid-a', now + 1), true);
  assert.equal(ownListsAreFresh('uid-b', now), false, 'nothing cached, nothing to trust');
  assert.equal(ownListsAreFresh(null!, now), false);
  forgetOwnLists('uid-a');
});

test('freshness expires, and the read happens again', () => {
  rememberOwnLists('uid-c', [{ id: 'l1' }]);
  const readAt = Date.now();
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS - 1), true);
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS), false, 'the window is exclusive');
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS + 5_000), false);
  forgetOwnLists('uid-c');
});

test('a write-through updates the lists WITHOUT pretending they were re-read', () => {
  // Otherwise every save would renew the window and the lists could go stale
  // for as long as somebody kept saving.
  rememberOwnLists('uid-d', [{ id: 'l1', paperIds: [] }]);
  const readAt = Date.now();
  reviseOwnLists('uid-d', [{ id: 'l1', paperIds: ['p1'] }]);

  assert.deepEqual(ownListsCache.get('uid-d'), [{ id: 'l1', paperIds: ['p1'] }]);
  assert.equal(ownListsAreFresh('uid-d', readAt + OWN_LISTS_FRESH_MS + 1), false,
    'the clock still runs from the last real read');
  forgetOwnLists('uid-d');
});

test('forgetting an account leaves nothing behind for the next one', () => {
  rememberOwnLists('uid-e', [{ id: 'l1' }]);
  forgetOwnLists('uid-e');
  assert.equal(ownListsCache.get('uid-e'), undefined);
  assert.equal(ownListsAreFresh('uid-e', Date.now()), false);
});

test('rubbish is refused rather than cached', () => {
  rememberOwnLists('uid-f', null!);
  rememberOwnLists(null!, [{ id: 'l1' }]);
  assert.equal(ownListsCache.get('uid-f'), undefined);
  assert.equal(ownListsAreFresh('uid-f', Date.now()), false);
});

// ENG-84. A list reopened in the session paints from this cache; the
// savedPapers document, which keeps no status, must not wipe the retraction
// the interaction's copy recorded.
test('a newer copy of a list paper replaces the older one but keeps its retraction', () => {
  rememberListPapers('uid-g', { 'pmid:9500320': { id: 'pmid:9500320', title: 'Old', publicationStatus: 'retracted' } }, 'interaction');
  rememberListPapers('uid-g', { 'pmid:9500320': { id: 'pmid:9500320', title: 'New', publicationStatus: 'preprint' } }, 'saved');
  assert.deepEqual(readListPapers('uid-g')?.['pmid:9500320'], { id: 'pmid:9500320', title: 'New', publicationStatus: 'retracted' });
});

// A list reopened in the same tab painted from whichever copy arrived last.
// Both collections are read at once, and the interaction's record of a paper
// saved before PAP-60 kept no field, date or abstract: landing after the
// savedPapers document, it replaced it in the cache while the screen's own
// state kept the document.
test('the cache keeps a list paper\'s savedPapers document over a later interaction copy', () => {
  const saved = { id: '2505.06123', title: 'Perfect absorption', categories: ['quant-ph'], year: 2025 };
  const interaction = { id: '2505.06123', title: 'Perfect absorption', categories: [], year: null };
  rememberListPapers('uid-h', { [saved.id]: saved }, 'saved');
  rememberListPapers('uid-h', { [saved.id]: interaction }, 'interaction');
  assert.deepEqual(readListPapers('uid-h')?.[saved.id], saved);

  rememberListPapers('uid-i', { [saved.id]: interaction }, 'interaction');
  rememberListPapers('uid-i', { [saved.id]: saved }, 'saved');
  assert.deepEqual(readListPapers('uid-i')?.[saved.id], saved, 'in either order');
});

test('a savedPapers answer is kept for the account that read it', () => {
  rememberSavedAnswers('uid-j', ['2505.06123']);
  rememberSavedAnswers('uid-j', ['2501.00001']);
  assert.equal(savedAnswered('uid-j', '2505.06123'), true);
  assert.equal(savedAnswered('uid-j', '2501.00001'), true);
  assert.equal(savedAnswered('uid-k', '2505.06123'), false, 'another account');
  assert.equal(savedAnswered('uid-j', '2509.99999'), false, 'never asked');
});

// Only a paper whose savedPapers document was read is asked of a provider
// for its field: the document is where the answer is kept.
test('a savedPapers document read is recorded for its account, an interaction copy is not', () => {
  rememberListPapers('uid-k', { '2505.06123': { id: '2505.06123', title: 'Saved' } }, 'saved');
  rememberListPapers('uid-k', { '2505.06124': { id: '2505.06124', title: 'Liked' } }, 'interaction');
  assert.equal(savedDocumentRead('uid-k', '2505.06123'), true);
  assert.equal(savedDocumentRead('uid-k', '2505.06124'), false);
  assert.equal(savedDocumentRead('uid-l', '2505.06123'), false, 'another account');
  assert.equal(savedDocumentRead(undefined, '2505.06123'), false);
});
