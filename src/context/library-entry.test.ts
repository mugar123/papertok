import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import type { LibraryEntry } from './library-entry.ts';
import { paperLegacyAdapter } from '../models/paper.ts';
import { serializeLibraryPaper } from '../utils/reading-library.ts';
import { buildSavedPaperPayload } from '../utils/saved-paper-payload.ts';
import { reviewTagForPaper } from '../utils/paper-status.ts';
import { hydrateSeededPaper } from '../utils/paper-seed.ts';
import { listPaperFromCopies } from '../utils/list-paper-copies.ts';
import { serializeInteractionPaper, libraryAfterRead, libraryAfterLoad, libraryCopyOf, libraryAfterInteraction, loadedAfterLoad, loadedAfterInteraction, readLaterChange, withLibraryCopy } from './library-entry.ts';

const throughFirestore = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const wakefield = { id: 'pmid:9500320', title: 'Ileal-lymphoid-nodular hyperplasia', journal: 'Lancet', publicationType: 'article' as const };
// The card PubMed gave, and the same paper from a provider that reports no retraction.
const retracted = { ...wakefield, publicationStatus: 'retracted' as const };
const unmarked = wakefield;
const savedDocument = (paper: Partial<Paper>) => paperLegacyAdapter({ id: paper.id, ...throughFirestore(buildSavedPaperPayload(paper, '2026-10-26T12:00:00.000Z')) });
const loadedCopy = (paper: Partial<Paper>) => throughFirestore(serializeLibraryPaper(paper));
// What the lists screen shows for a library paper, with and without a savedPapers document.
const listTags = (library: Record<string, LibraryEntry>) => {
  const copy = library[wakefield.id].paper;
  return [reviewTagForPaper(paperLegacyAdapter(copy))?.key, reviewTagForPaper(listPaperFromCopies(copy, savedDocument(unmarked)))?.key];
};

// ENG-84. A read mark, Read later, a note or tags replaced the library's copy
// with the copy of the card they were made on, so a paper PubMed called
// retracted read as a preprint on the lists screen once marked from a card
// whose provider does not report the retraction, until a reload.
test('a library entry keeps a retraction its earlier copy recorded when a mark rewrites its copy', () => {
  const readLater = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(retracted), { readLater: true, updatedAt: '2026-10-29T10:00:00.000Z' });
  const read = withLibraryCopy(readLater, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-29T11:00:00.000Z' });
  assert.deepEqual(listTags(read), ['retracted', 'retracted'], 'Read later, then read');
  assert.equal(read[wakefield.id].readLater, true, 'the read mark keeps Read later');
  const noted = withLibraryCopy(readLater, wakefield.id, serializeLibraryPaper(unmarked), { note: 'Check the retraction notice.', tags: ['mmr'] });
  assert.deepEqual(listTags(noted), ['retracted', 'retracted'], 'Read later, then a note');
});

test('a library entry keeps the retraction of the copy the library loaded', () => {
  // Liked while retracted, then marked read from another card: the entry is new.
  const loaded = loadedCopy(retracted);
  const read = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-29T11:00:00.000Z' }, loaded);
  assert.deepEqual(listTags(read), ['retracted', 'retracted'], 'liked, then read');

  // Marked read before the library loaded: the load keeps the entry this
  // session wrote and the stored copy's retraction.
  const current = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-29T11:00:00.000Z' });
  const afterLoad = libraryAfterLoad(current, { [wakefield.id]: { paperId: wakefield.id, paper: loaded } }, { [wakefield.id]: loaded });
  assert.deepEqual(listTags(afterLoad), ['retracted', 'retracted'], 'read, then the library loaded');
  assert.equal(afterLoad[wakefield.id].readAt, '2026-10-29T11:00:00.000Z');
});

// The load read the record before the read mark's write landed, when it was
// only liked: it gave the record no entry, and the retraction was lost.
test('a load keeps the retraction of a record only liked or saved on an entry this session wrote', () => {
  const current = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-29T11:00:00.000Z' });
  const afterLoad = libraryAfterLoad(current, {}, { [wakefield.id]: loadedCopy(retracted) });
  assert.deepEqual(listTags(afterLoad), ['retracted', 'retracted']);
  assert.equal(afterLoad[wakefield.id].readAt, '2026-10-29T11:00:00.000Z');
  // A record whose copy has no real title is left out of the loaded copies,
  // but not out of the entries.
  const untitled = loadedCopy({ ...retracted, title: '' });
  const fromEntry = libraryAfterLoad(current, { [wakefield.id]: { paperId: wakefield.id, paper: untitled } }, {});
  assert.deepEqual(listTags(fromEntry), ['retracted', 'retracted'], 'an untitled record');
  // A paper only the load read keeps its record's entry as it was.
  const other = { paperId: 'pmid:1', paper: loadedCopy({ ...unmarked, id: 'pmid:1' }), readLater: true };
  assert.equal(libraryAfterLoad(current, { 'pmid:1': other }, {})['pmid:1'], other);
});

test('a load keeps a retraction either the copy in memory or the stored copy records', () => {
  const tag = (copy: Partial<Paper>) => reviewTagForPaper(paperLegacyAdapter(copy))?.key;
  const before = { [wakefield.id]: loadedCopy(unmarked) };
  // Retracted on another device since this session first loaded the library.
  assert.equal(tag(loadedAfterLoad(before, { [wakefield.id]: loadedCopy(retracted) })[wakefield.id]), 'retracted', 'stored copy');
  assert.equal(tag(loadedAfterLoad({ [wakefield.id]: loadedCopy(retracted) }, { [wakefield.id]: loadedCopy(unmarked) })[wakefield.id]), 'retracted', 'copy in memory');
  // Otherwise the copy in memory wins, and a copy only the load read is added.
  const afterLoad = loadedAfterLoad(before, { [wakefield.id]: loadedCopy(unmarked), 'pmid:1': loadedCopy({ ...unmarked, id: 'pmid:1' }) });
  assert.equal(afterLoad[wakefield.id], before[wakefield.id]);
  assert.equal(afterLoad['pmid:1'].id, 'pmid:1');
});

// ENG-84. The paper page, reached by a link without a copy of its own (a
// public list's row), lays the library's copy over the provider's answer. It
// took the loaded copy over the entry's, so after Read later from a PubMed
// card the list read Retracted and the paper page did not.
test('the library copy the paper page uses keeps a retraction either copy records', () => {
  const answer = paperLegacyAdapter(unmarked);
  const pageTag = (library: Record<string, LibraryEntry>, papers: Record<string, Partial<Paper>>) => {
    const copy = libraryCopyOf(library, papers, wakefield.id);
    return copy && reviewTagForPaper(hydrateSeededPaper(paperLegacyAdapter({ ...copy, id: wakefield.id }), answer))?.key;
  };
  // The library as loaded, with a copy stored before the retraction.
  const papers = { [wakefield.id]: loadedCopy(unmarked) };
  const library = { [wakefield.id]: { paperId: wakefield.id, paper: papers[wakefield.id] } };
  const readLater = withLibraryCopy(library, wakefield.id, serializeLibraryPaper(retracted), { readLater: true }, papers[wakefield.id]);
  assert.equal(pageTag(readLater, papers), 'retracted', 'Read later from a retracted card');
  assert.equal(pageTag(library, { [wakefield.id]: loadedCopy(retracted) }), 'retracted', 'a retracted loaded copy');
  assert.equal(pageTag(readLater, {}), 'retracted', 'no loaded copy');
  assert.notEqual(pageTag(library, papers), 'retracted', 'no copy retracted');
  assert.equal(libraryCopyOf({}, {}, wakefield.id), undefined);
});

// A like or a save in this session wrote the retracted copy to the stored
// interaction only, so a later mark from an unmarked card found no retraction
// in memory and the lists read Preprint until a reload.
test('a like or a save in this session keeps its retraction through a later mark', () => {
  const liked = serializeLibraryPaper(retracted);
  // Nothing loaded for the paper yet, or the copy stored before the refresh.
  for (const [label, before] of [['nothing loaded', {}], ['an unmarked copy loaded', { [wakefield.id]: loadedCopy(unmarked) }]] as const) {
    const papers = loadedAfterInteraction(before, wakefield.id, liked);
    const library = libraryAfterInteraction({}, wakefield.id, liked);
    const readLater = withLibraryCopy(library, wakefield.id, serializeLibraryPaper(unmarked), { readLater: true }, papers[wakefield.id]);
    assert.deepEqual(listTags(readLater), ['retracted', 'retracted'], `liked, then Read later: ${label}`);
    const read = withLibraryCopy(library, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-29T11:00:00.000Z' }, papers[wakefield.id]);
    assert.deepEqual(listTags(read), ['retracted', 'retracted'], `liked, then read: ${label}`);
  }
});

test('a like or a save in this session adds its retraction to an entry an earlier mark wrote', () => {
  const marked = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(unmarked), { readLater: true });
  const liked = libraryAfterInteraction(marked, wakefield.id, serializeLibraryPaper(retracted));
  assert.deepEqual(listTags(liked), ['retracted', 'retracted']);
  assert.equal(liked[wakefield.id].readLater, true);
});

test('a repeated interaction reuses its copy when the journal and retraction are unchanged', () => {
  const marked = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(unmarked), { readLater: true });
  const papers = { [wakefield.id]: loadedCopy(unmarked) };
  assert.equal(libraryAfterInteraction(marked, wakefield.id, serializeLibraryPaper(unmarked)), marked);
  assert.equal(loadedAfterInteraction(papers, wakefield.id, serializeLibraryPaper(unmarked)), papers);
  assert.deepEqual(loadedAfterInteraction({}, wakefield.id, serializeLibraryPaper(unmarked))[wakefield.id], papers[wakefield.id]);
});

test('a library read keeps an intervening save, then accepts a newer server journal', () => {
  const before = { personalLibrary: {}, libraryPapers: {} };
  const old = loadedCopy({ ...wakefield, venueId: 'S23254222', sourceName: 'First journal' });
  const revised = serializeLibraryPaper({ ...wakefield, journal: 'Another journal' });
  const current = { ...before, libraryPapers: loadedAfterInteraction({}, wakefield.id, revised) };
  const entries = withLibraryCopy({}, wakefield.id, old, { readLater: true });
  const papers = { [wakefield.id]: old };
  const merged = libraryAfterRead(current, before, entries, papers, false);
  assert.equal(merged.personalLibrary[wakefield.id].readLater, true);
  for (const paper of [merged.personalLibrary[wakefield.id].paper, merged.libraryPapers[wakefield.id]]) {
    assert.equal(paper.journal, 'Another journal');
    assert.ok(!paper.venueId);
  }
  const refreshed = libraryAfterRead(merged, merged, entries, papers, false);
  assert.equal(refreshed.personalLibrary[wakefield.id].paper.venueId, 'S23254222');
  assert.equal(refreshed.libraryPapers[wakefield.id].sourceName, 'First journal');
});

test('an earlier save acknowledgement keeps the journal of a later read mark', () => {
  const saved = serializeLibraryPaper({ ...wakefield, venueId: 'S23254222' });
  const later = serializeLibraryPaper({ ...wakefield, journal: 'Another journal' });
  const read = withLibraryCopy({}, wakefield.id, later, { readAt: '2026-10-29T11:00:00.000Z' });
  const library = libraryAfterInteraction(read, wakefield.id, saved, undefined);
  assert.equal(library[wakefield.id].paper.journal, 'Another journal');
  assert.ok(!library[wakefield.id].paper.venueId);
});

test('a library entry no copy called retracted reads as before', () => {
  const read = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-29T11:00:00.000Z' }, loadedCopy(unmarked));
  assert.equal('publicationStatus' in read[wakefield.id].paper, false);
  assert.notEqual(listTags(read)[0], 'retracted');
});

test('saving a revised journal replaces the link on both copies held by the reader', () => {
  const old = loadedCopy({ ...wakefield, venueId: 'S23254222', sourceName: 'First journal' });
  const revised = serializeLibraryPaper({ ...wakefield, journal: 'Another journal' });
  const papers = loadedAfterInteraction({ [wakefield.id]: old }, wakefield.id, revised);
  const marked = withLibraryCopy({}, wakefield.id, old, { readLater: true });
  const library = libraryAfterInteraction(marked, wakefield.id, revised, marked[wakefield.id]);
  for (const entries of [{}, library]) {
    const copy = libraryCopyOf(entries, papers, wakefield.id);
    assert.ok(copy);
    const paper = paperLegacyAdapter(copy);
    assert.equal(paper.journal, 'Another journal');
    assert.equal(paper.venueId, undefined);
    assert.equal(paper.sourceName, undefined);
  }
  assert.equal(library[wakefield.id].readLater, true);
});

// A Read later change stamps its copy through readLaterStamp (ENG-156), which
// knows nothing of retractions. The card's copy alone replaced a retracted
// one, so the lists read Preprint, and so did a later read mark from a card
// without the retraction.
test('Read later from a card without the retraction keeps it, through a later read mark', () => {
  const library = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(retracted), { readAt: '2026-10-29T11:00:00.000Z' });
  const change = readLaterChange(wakefield.id, library[wakefield.id], {
    copy: serializeLibraryPaper(unmarked), readLater: true, updatedAt: '2026-10-30T09:00:00.000Z', late: false,
  });
  const readLater = change.show(library);
  assert.deepEqual(listTags(readLater), ['retracted', 'retracted'], 'read, then Read later');
  assert.equal(readLater[wakefield.id].readLater, true);
  const read = withLibraryCopy(readLater, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-30T10:00:00.000Z' });
  assert.deepEqual(listTags(read), ['retracted', 'retracted'], 'then read again');
});

test('a removal from Read later, shown once accepted, keeps the retraction', () => {
  const library = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(retracted), { readLater: true, updatedAt: '2026-10-29T10:00:00.000Z' });
  const removed = readLaterChange(wakefield.id, library[wakefield.id], {
    copy: serializeLibraryPaper(unmarked), readLater: false, updatedAt: '2026-10-30T09:00:00.000Z', late: true,
  }).show(library);
  assert.deepEqual(listTags(removed), ['retracted', 'retracted']);
  assert.equal(removed[wakefield.id].readLater, false);
});

test('Read later keeps the retraction a like in this session stored, with no entry yet', () => {
  const loaded = loadedAfterInteraction({}, wakefield.id, serializeLibraryPaper(retracted))[wakefield.id];
  const readLater = readLaterChange(wakefield.id, undefined, {
    copy: serializeLibraryPaper(unmarked), readLater: true, updatedAt: '2026-10-30T09:00:00.000Z', late: false, loaded,
  }).show({});
  assert.deepEqual(listTags(readLater), ['retracted', 'retracted']);
});

// The undo of a refused change puts the earlier copy back only while the entry
// holds the copy its change put there, so the retraction must not make that
// copy a different object.
test('a refused Read later change puts back the entry as it was, retraction and all', () => {
  const library = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(retracted), { readAt: '2026-10-29T11:00:00.000Z' });
  const previous = library[wakefield.id];
  const change = readLaterChange(wakefield.id, previous, {
    copy: serializeLibraryPaper({ ...unmarked, journal: 'The Lancet' }), readLater: true, updatedAt: '2026-10-30T09:00:00.000Z', late: false,
  });
  const shown = change.show(library);
  assert.equal(shown[wakefield.id].paper.journal, 'The Lancet');
  const restored = change.undo(shown)[wakefield.id];
  assert.equal(restored.paper, previous.paper);
  assert.equal(restored.readLater, false);
  assert.equal(restored.updatedAt, undefined);
  assert.equal(restored.readAt, '2026-10-29T11:00:00.000Z');
});

test('liking and saving keep the corpus conference and its provenance across a library reload', () => {
  const acceptedConference = { id: 'S4306419644', label: 'ICML', evidence: 'openreview' as const };
  const card = paperLegacyAdapter({ id: '2611.26060', title: 'A stored paper', acceptedConference });
  const staleCard = { ...card, acceptedConference: { id: 'S4363606243', label: 'NeurIPS', year: 2025, evidence: 'arxiv-comment' as const } };
  const copy = serializeLibraryPaper(card);
  const state = { personalLibrary: {}, libraryPapers: { [card.id]: throughFirestore(copy) } };
  assert.deepEqual(serializeInteractionPaper(staleCard, state).acceptedConference, acceptedConference);
  const saved = buildSavedPaperPayload(card);
  const loaded = loadedAfterInteraction(state.libraryPapers, card.id, serializeLibraryPaper(staleCard));
  assert.deepEqual(loaded[card.id].acceptedConference, acceptedConference);
  assert.deepEqual(listPaperFromCopies(loaded[card.id], throughFirestore(saved)).acceptedConference, acceptedConference);
  assert.deepEqual(hydrateSeededPaper(staleCard, card)?.acceptedConference, acceptedConference);
});

test('a newer corpus answer removes a stale mark across a like, save, reload and paper page', () => {
  const mark = { id: 'S4306419637', label: 'ICLR', year: 2025, evidence: 'openreview' as const };
  const provider = paperLegacyAdapter({ id: 'openreview:abc', title: 'A withdrawn paper' });
  const old = { ...provider, acceptedConference: mark, corpusUpdatedAt: 100 };
  const corpus = { ...provider, corpusUpdatedAt: 200 };
  const known = { [old.id]: loadedCopy(old) };
  const entries = withLibraryCopy({}, old.id, known[old.id], { readLater: true });
  const state = { libraryPapers: known, personalLibrary: entries };
  const liked = serializeInteractionPaper(corpus, state);
  const loaded = loadedAfterInteraction(known, old.id, liked);
  const library = libraryAfterInteraction(entries, old.id, liked, entries[old.id]);
  const copy = libraryCopyOf(library, loaded, old.id);
  const saved = savedDocument(corpus);
  for (const paper of [liked, loaded[old.id], library[old.id].paper, copy, saved,
    listPaperFromCopies(loadedCopy(copy), savedDocument(old)),
    listPaperFromCopies(known[old.id], saved),
    hydrateSeededPaper(old, corpus), hydrateSeededPaper(corpus, provider)]) {
    assert.ok(paper);
    assert.equal(paper.acceptedConference, undefined);
  }
  const direct = serializeInteractionPaper(provider, state);
  assert.equal('acceptedConference' in direct, false);
  assert.equal('corpusUpdatedAt' in direct, false);
  assert.deepEqual(loadedAfterInteraction(known, old.id, direct)[old.id].acceptedConference, mark);
  assert.deepEqual(hydrateSeededPaper(old, provider)?.acceptedConference, mark);
  assert.deepEqual(hydrateSeededPaper(saved, { ...old, corpusUpdatedAt: 300 })?.acceptedConference, mark);
});
