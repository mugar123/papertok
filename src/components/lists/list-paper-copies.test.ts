import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../../models/paper.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import { serializeLibraryPaper } from '../../utils/reading-library.ts';
import { buildSavedPaperPayload } from '../../utils/saved-paper-payload.ts';
import { reviewTagForPaper } from '../../utils/paper-status.ts';
import { sourceAttribution } from '../../utils/source-attribution.ts';
import { listPaper, listPaperFromCopies, mergeListPaperCopies } from './list-paper-copies.ts';

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
