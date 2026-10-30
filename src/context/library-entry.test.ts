import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import type { LibraryEntry } from './library-entry.ts';
import { paperLegacyAdapter } from '../models/paper.ts';
import { serializeLibraryPaper } from '../utils/reading-library.ts';
import { buildSavedPaperPayload } from '../utils/saved-paper-payload.ts';
import { reviewTagForPaper } from '../utils/paper-status.ts';
import { listPaperFromCopies } from '../components/lists/list-paper-copies.ts';
import { withLibraryCopy } from './library-entry.ts';

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
  const afterLoad = withLibraryCopy(current, wakefield.id, current[wakefield.id].paper, {}, loaded);
  assert.deepEqual(listTags(afterLoad), ['retracted', 'retracted'], 'read, then the library loaded');
  assert.equal(afterLoad[wakefield.id].readAt, '2026-10-29T11:00:00.000Z');
});

test('a library entry no copy called retracted reads as before', () => {
  const read = withLibraryCopy({}, wakefield.id, serializeLibraryPaper(unmarked), { readAt: '2026-10-29T11:00:00.000Z' }, loadedCopy(unmarked));
  assert.equal('publicationStatus' in read[wakefield.id].paper, false);
  assert.notEqual(listTags(read)[0], 'retracted');
});
