import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../../models/paper.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import { serializeLibraryPaper } from '../../utils/reading-library.ts';
import { buildSavedPaperPayload } from '../../utils/saved-paper-payload.ts';
import { sourceAttribution } from '../../utils/source-attribution.ts';
import { listPaperFromCopies } from './list-paper-copies.ts';

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
