import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../../models/paper.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import { serializeLibraryPaper } from '../../utils/reading-library.ts';
import { buildSavedPaperPayload } from '../../utils/saved-paper-payload.ts';
import { listPaperFromCopies } from './list-paper-copies.ts';
import { listAbstractText } from './list-abstract-text.ts';

// The copies as the lists page holds them (see list-paper-copies.test.ts).
const throughFirestore = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const interactionCopy = (paper: Partial<Paper>): Partial<Paper> => throughFirestore(serializeLibraryPaper(paper));
const savedDocument = (paper: Partial<Paper>) => paperLegacyAdapter({ id: paper.id, ...throughFirestore(buildSavedPaperPayload(paper, '2026-11-12T12:00:00.000Z')) });

// A synthetic abstract of 1,200 characters: longer than a saved document
// keeps, shorter than an interaction's copy keeps.
const sentence = 'Coherent control of molecular dynamics with quantum light is studied in a cavity. ';
const abstract = sentence.repeat(15).trim();
const paper = { id: 'arxiv:1901.00001', title: 'Quantum control with quantum light', abstract };

test('a list row shows the longer copy of the abstract when both are loaded, whole', () => {
  const shown = listAbstractText(listPaperFromCopies(interactionCopy(paper), savedDocument(paper)));
  assert.equal(shown?.text, abstract);
  assert.equal(shown?.cut, false);
});

test('a list row marks the saved document\'s excerpt as cut', () => {
  const shown = listAbstractText(savedDocument(paper));
  assert.equal(shown?.text, abstract.slice(0, 500).trim());
  assert.equal(shown?.cut, true);
});

test('a short abstract kept whole is not marked as cut', () => {
  const short = 'We show that some quantum physics situations appear as manifestations of the Klein group.';
  assert.deepEqual(listAbstractText(savedDocument({ ...paper, abstract: short })), { text: short, cut: false });
});

test('a copy with no abstract shows none, not the placeholder', () => {
  assert.equal(listAbstractText(savedDocument({ id: paper.id, title: paper.title })), null);
});
