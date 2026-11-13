import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { paperLegacyAdapter, readStoredClassification } from '../models/paper.ts';
import { copyOfRecordWithoutCopy, serializeLibraryPaper } from './reading-library.ts';
import { buildSavedPaperPayload } from './saved-paper-payload.ts';
import { reviewTagForPaper } from './paper-status.ts';
import { sourceAttribution } from './source-attribution.ts';
import { getCategoryLabel } from '../data/categories.ts';
import { listAbstractText } from '../components/lists/list-abstract-text.ts';
import { listPaper, listPaperFromCopies, listPaperNeedsFieldRead, listPaperNeedsRead, mergeListPaperCopies } from './list-paper-copies.ts';

const recovered = 'The abstract Semantic Scholar holds for this journal article, in full.';
const own = 'The abstract OpenAlex now lists for this journal article itself.';
const card = { id: 'openalex:W4410000002', title: 'A journal article', sources: { primary: 'openalex', enrichedBy: [] } };
const credited = { ...card, abstract: recovered, abstractSource: 'semanticscholar' as const };
const uncredited = { ...card, abstract: own };

// The copies as the lists page holds them: an interaction's as stored, a
// savedPapers document read back as a paper.
const throughFirestore = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const interactionCopy = (paper: Partial<Paper>): Partial<Paper> => throughFirestore(serializeLibraryPaper(paper));
const savedDocument = (paper: Partial<Paper>) => paperLegacyAdapter({ id: paper.id, ...throughFirestore(buildSavedPaperPayload(paper, '2026-10-26T12:00:00.000Z')) });
const shown = (paper: Partial<Paper>) => [paper.abstract, sourceAttribution(paper)?.label ?? null, sourceAttribution(paper)?.name ?? null];

// ENG-109. A list paper with two copies took its text from one and its
// credit from the other, whichever named a source: the paper read after
// OpenAlex's own abstract replaced the one Semantic Scholar supplied showed
// OpenAlex's text over "Abstract: Semantic Scholar".
test('a list paper credits the source of the text it shows, not the other copy\'s', () => {
  assert.deepEqual(
    shown(listPaperFromCopies(interactionCopy(credited), savedDocument(uncredited))),
    [own, null, null],
    'liked with the recovered text, saved with OpenAlex\'s',
  );
  assert.deepEqual(
    shown(listPaperFromCopies(interactionCopy(uncredited), interactionCopy(credited))),
    [own, null, null],
    'marked read in this session, over the copy the library read when the list opened',
  );
  assert.deepEqual(
    shown(listPaperFromCopies(interactionCopy(uncredited), savedDocument(credited))),
    [recovered, 'Abstract:', 'Semantic Scholar'],
    'saved with the recovered text, read with OpenAlex\'s: the saved text shows',
  );
  // Either copy of the credited text gives it its credit.
  for (const [library, other] of [
    [interactionCopy(credited), savedDocument(credited)],
    [interactionCopy(credited), savedDocument({ ...card, abstract: recovered })],
    [interactionCopy({ ...card, abstract: recovered }), savedDocument(credited)],
    [interactionCopy({ ...card, abstract: recovered }), interactionCopy(credited)],
  ]) {
    assert.deepEqual(shown(listPaperFromCopies(library, other)), [recovered, 'Abstract:', 'Semantic Scholar']);
  }
});

// ENG-84. A retracted paper liked or saved from search came back in a list as
// a preprint: neither copy kept the retraction, and the savedPapers document,
// which keeps no status, replaced the interaction's copy.
test('a list paper liked or saved while retracted reads Retracted, whichever copy arrives first', () => {
  const wakefield = { id: 'pmid:9500320', title: 'Ileal-lymphoid-nodular hyperplasia', journal: 'Lancet', publicationType: 'article' as const, publicationStatus: 'retracted' as const };
  const liked = paperLegacyAdapter(interactionCopy(wakefield));
  const saved = savedDocument(wakefield);
  const tag = (paper: Partial<Paper> | undefined) => reviewTagForPaper(paper)?.key;

  assert.equal(tag(liked), 'retracted', 'the interaction copy');
  assert.equal(tag(listPaperFromCopies(interactionCopy(wakefield), saved)), 'retracted', 'both copies');
  for (const [first, second] of [['saved', 'interaction'], ['interaction', 'saved']] as const) {
    const copies = { saved, interaction: liked };
    const once = mergeListPaperCopies({}, { [wakefield.id]: copies[first] }, first);
    const twice = mergeListPaperCopies(once, { [wakefield.id]: copies[second] }, second);
    assert.equal(tag(twice[wakefield.id]), 'retracted', `${first} then ${second}`);
  }

  // Only a retraction is kept: a paper no provider called retracted stores no
  // status, so its copy reads as it always did.
  const published = interactionCopy({ ...wakefield, publicationStatus: 'published' });
  assert.equal('publicationStatus' in published, false);
  assert.notEqual(tag(paperLegacyAdapter(published)), 'retracted');
});

// ENG-84. With a library entry and a fetched copy, a list paper ignored the
// copy the library loaded: a like of a retracted card while the library was
// loading put the retraction there only, and the row read Preprint.
test('a list paper reads Retracted when any copy the screen holds records it', () => {
  const wakefield = { id: 'pmid:9500320', title: 'Ileal-lymphoid-nodular hyperplasia', journal: 'Lancet', publicationType: 'article' as const };
  const retracted = interactionCopy({ ...wakefield, publicationStatus: 'retracted' });
  const unmarked = interactionCopy(wakefield);
  const saved = savedDocument(wakefield);
  const tag = (paper: Partial<Paper> | undefined) => paper && reviewTagForPaper(paperLegacyAdapter(paper))?.key;
  const cases: [string, Partial<Paper> | undefined, Partial<Paper> | undefined, Partial<Paper> | undefined][] = [
    ['entry, fetched copy, loaded copy retracted', unmarked, saved, retracted],
    ['entry retracted, fetched copy, loaded copy', retracted, saved, unmarked],
    ['entry retracted, fetched copy', retracted, saved, undefined],
    ['entry retracted, loaded copy', retracted, undefined, unmarked],
    ['entry, loaded copy retracted', unmarked, undefined, retracted],
    ['fetched copy, loaded copy retracted', undefined, saved, retracted],
    ['loaded copy retracted', undefined, undefined, retracted],
    ['entry retracted', retracted, undefined, undefined],
  ];
  for (const [label, entry, fetched, loaded] of cases) {
    assert.equal(tag(listPaper(entry, fetched, loaded)), 'retracted', label);
  }
  assert.notEqual(tag(listPaper(unmarked, saved, unmarked)), 'retracted', 'no copy retracted');
  assert.equal(listPaper(undefined, undefined, undefined), undefined, 'no copy');
});

// A paper saved before PAP-60 (2026-10-21) has an interaction record with no
// copy: its title, three authors, the card's category and the start of its
// text. The library made a copy of it dated the day it was saved, and that
// copy kept the list from reading the paper's savedPapers document, so the
// row read "2026", three names, no field and no abstract. Synthetic card,
// shaped on arXiv 2505.06123 (quant-ph, 9 May 2025, ten authors).
const legacyCard = {
  id: '2505.06123',
  title: 'Observation of Perfect Absorption in Hyperfine Levels of Molecular Spins with Hermitian Subspaces',
  authors: Array.from({ length: 10 }, (_, index) => ({ name: `Author ${index + 1}` })),
  primaryCategory: 'quant-ph',
  categories: ['quant-ph'],
  published: '2025-05-09T17:59:00Z',
  summary: 'We observe perfect absorption in the hyperfine levels of molecular spins coupled to a superconducting resonator.',
};
// The record the save wrote then.
const legacyRecord = throughFirestore({
  saved: true,
  paperTitle: legacyCard.title,
  paperAuthors: legacyCard.authors.slice(0, 3),
  paperCategory: 'physics.optics',
  paperAbstract: legacyCard.summary.substring(0, 500),
  timestamp: '2026-09-20T10:00:00.000Z',
});
// As the library loads it, and as the lists screen reads it itself.
const loadedRecord = () => throughFirestore(copyOfRecordWithoutCopy(legacyCard.id, legacyRecord));
const readRecord = () => paperLegacyAdapter(copyOfRecordWithoutCopy(legacyCard.id, legacyRecord));
const row = (paper: Partial<Paper> | undefined) => ({
  field: paper?.categories?.[0] ? getCategoryLabel(paper.categories[0]) : null,
  year: paper?.year || null,
  text: (paper && listAbstractText(paper)?.text) || null,
  authors: paper?.authors?.length ?? 0,
});
const fullRow = { field: getCategoryLabel('quant-ph'), year: 2025, text: legacyCard.summary, authors: 10 };

test('a list paper saved before PAP-60 reads its savedPapers document', () => {
  const loaded = loadedRecord();
  const saved = savedDocument(legacyCard);
  // What the screen holds when the list opens: the library's copy only, or
  // an entry with it too (a read mark or Read later on the record).
  assert.equal(listPaperNeedsRead([undefined, undefined, loaded], false), true);
  assert.equal(listPaperNeedsRead([loaded, undefined, loaded], false), true);
  assert.deepEqual(row(listPaper(undefined, saved, loaded)), fullRow);
  assert.deepEqual(row(listPaper(loaded, saved, loaded)), fullRow);
});

// A mark made on that row, or a save from its card, stores the row's copy as
// the record's own: next session the record has a copy, and it is as empty.
test('a copy written back from such a row still has its savedPapers document read', () => {
  const shown = listPaper(undefined, undefined, loadedRecord())!;
  const written = throughFirestore({ paper: serializeLibraryPaper(shown) });
  // The next session's library load, and the lists screen's own read.
  const reloaded = { ...written.paper, ...readStoredClassification({ ...written.paper, id: legacyCard.id }) };
  const reread = paperLegacyAdapter(written.paper);
  for (const [label, copy] of [['loaded', reloaded], ['read by the screen', reread], ['the record, read by the screen', readRecord()]] as const) {
    assert.equal(listPaperNeedsRead([undefined, copy, undefined], false), true, label);
  }
});

test('a paper without a field or date is read until its savedPapers read answers', () => {
  const copies = [undefined, readRecord(), loadedRecord()];
  assert.equal(listPaperNeedsRead(copies, false), true, 'the savedPapers half failed: still to read');
  assert.equal(listPaperNeedsRead(copies, true), false, 'answered, with no document: settled');
  assert.equal(listPaperNeedsRead([undefined, undefined, undefined], true), true, 'no copy at all');
});

test('a list paper with a field or a date of its own is not read again', () => {
  const copy = interactionCopy(legacyCard);
  assert.equal(listPaperNeedsRead([undefined, undefined, copy], false), false, 'the interaction\'s copy');
  assert.equal(listPaperNeedsRead([copy, undefined, loadedRecord()], false), false, 'an entry with a copy');
  assert.equal(listPaperNeedsRead([undefined, savedDocument(legacyCard), loadedRecord()], false), false, 'its document');
  assert.equal(listPaperNeedsRead([undefined, undefined, interactionCopy({ ...legacyCard, categories: [], primaryCategory: '' })], false), false, 'a date alone');
});

// A paper liked from an OpenAlex card and saved, both before PAP-60: the
// like's copy has a date and concept names for categories. Its document may
// hold a field a provider gave since, so that document alone is read.
test('a copy with a date and no field has its savedPapers document read for the field', () => {
  const liked = throughFirestore({ id: 'openalex:W4410000003', title: 'A journal article', categories: ['Qubit'], primaryCategory: 'Qubit', published: '2025-05-09' });
  assert.equal(listPaperNeedsRead([undefined, undefined, liked], false), false, 'the row is painted: not the whole read');
  assert.equal(listPaperNeedsFieldRead([undefined, undefined, liked], false), true);
  assert.equal(listPaperNeedsFieldRead([undefined, undefined, liked], true), false, 'answered: settled');
  assert.equal(listPaperNeedsFieldRead([undefined, undefined, interactionCopy(legacyCard)], false), false, 'a copy with a field');
  assert.equal(listPaperNeedsFieldRead([undefined, undefined, loadedRecord()], false), false, 'no field and no date: the whole read covers it');
  const filled = paperLegacyAdapter({ id: liked.id, title: liked.title, primaryCategory: 'Qubit', published: liked.published, primaryTopic: { id: 'https://openalex.org/T10020', field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' } } });
  assert.equal(listPaper(undefined, filled, liked)?.primaryTopic?.field?.display_name, 'Physics and Astronomy');
});

test('a record without a copy gives no publication year, no field, and the text it kept', () => {
  assert.deepEqual(row(listPaper(undefined, undefined, loadedRecord())), {
    field: null, year: null, text: legacyCard.summary, authors: 3,
  });
  assert.deepEqual(row(readRecord()), { field: null, year: null, text: legacyCard.summary, authors: 3 });
});

test('a list paper takes the longest list of authors its copies hold', () => {
  // Written from a card whose authors were `{ name }` objects, before the
  // document kept their names: it has none.
  const withoutAuthors = savedDocument({ ...legacyCard, authors: [] });
  // Written when the document kept five names.
  const fiveAuthors = savedDocument({ ...legacyCard, authors: legacyCard.authors.slice(0, 5) });
  assert.deepEqual(row(listPaper(undefined, withoutAuthors, loadedRecord())), { ...fullRow, authors: 3 });
  assert.deepEqual(row(listPaper(undefined, fiveAuthors, loadedRecord())), { ...fullRow, authors: 5 });
  assert.deepEqual(row(listPaper(interactionCopy(legacyCard), fiveAuthors, undefined)), fullRow, 'over an entry with a copy');
  assert.deepEqual(row(listPaper(undefined, savedDocument(legacyCard), loadedRecord())), fullRow, 'a document of today');
  // Read by the screen from both collections, in either order.
  for (const [first, second] of [['saved', 'interaction'], ['interaction', 'saved']] as const) {
    const copies = { saved: withoutAuthors, interaction: readRecord() };
    const once = mergeListPaperCopies({}, { [legacyCard.id]: copies[first] }, first);
    const twice = mergeListPaperCopies(once, { [legacyCard.id]: copies[second] }, second);
    assert.deepEqual(row(twice[legacyCard.id]), { ...fullRow, authors: 3 }, `${first} then ${second}`);
  }
});

// The document a save wrote before 2026-10-21: one category, no list of them
// and no version. It is not evidence of the field, so it reads back with none.
const oldSavedDocument = () => paperLegacyAdapter(throughFirestore({
  id: legacyCard.id, title: legacyCard.title, primaryCategory: 'quant-ph', published: legacyCard.published,
  summary: legacyCard.summary, savedAt: '2026-09-20T10:00:00.000Z',
}));

test('a saved document with no field does not erase the field another copy holds', () => {
  assert.equal(row(oldSavedDocument()).field, null, 'the document alone has no field');
  // A like or a read mark made later, from a card that carried its categories.
  const marked = interactionCopy(legacyCard);
  assert.equal(row(listPaper(marked, oldSavedDocument(), undefined)).field, fullRow.field, 'under an entry with a copy');
  assert.equal(row(listPaper(undefined, oldSavedDocument(), marked)).field, fullRow.field, 'over the copy the library loaded');
  for (const [first, second] of [['saved', 'interaction'], ['interaction', 'saved']] as const) {
    const copies = { saved: oldSavedDocument(), interaction: paperLegacyAdapter(marked) };
    const once = mergeListPaperCopies({}, { [legacyCard.id]: copies[first] }, first);
    const twice = mergeListPaperCopies(once, { [legacyCard.id]: copies[second] }, second);
    assert.equal(row(twice[legacyCard.id]).field, fullRow.field, `${first} then ${second}`);
  }
});

test('a category an old copy kept under another provider\'s id is still not a field', () => {
  // An OpenAlex card liked before PAP-60: its categories were concept names.
  const liked = throughFirestore({ id: 'openalex:W4410000003', title: 'A journal article', categories: ['Qubit'], primaryCategory: 'Qubit', published: '2025-05-09' });
  const saved = paperLegacyAdapter({ id: liked.id, title: liked.title, primaryCategory: 'Qubit', published: liked.published });
  assert.equal(row(listPaper(liked, saved, undefined)).field, null);
  assert.equal(row(listPaper(undefined, saved, liked)).field, null);
});

test('a device copy with unknown citations does not replace a known library count', () => {
  const cached = paperLegacyAdapter({ id: '2505.06123', title: 'Paper', year: 2025 });
  const library = { ...cached, citationCount: 42, citationCountKnown: true };
  assert.equal(listPaper(library, cached, undefined)?.citationCount, 42);
  assert.equal(listPaper(undefined, cached, library)?.citationCount, 42);
  assert.equal(mergeListPaperCopies({ [cached.id]: cached }, { [cached.id]: library }, 'interaction')[cached.id].citationCount, 42);
  assert.equal(listPaper({ ...library, citationCount: 0 }, cached, undefined)?.citationCountKnown, true);
});
