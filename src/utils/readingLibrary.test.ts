import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Paper } from '../models/Paper.ts';
import type { OpenAlexWork } from '../services/adapters/openAlexTypes.ts';
import { paperLegacyAdapter } from '../models/Paper.ts';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.ts';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { areaAccentForPaper, areaKeyForPaper, areaLabelForPaper } from './areaAccent.ts';
import { papersToBibTeX, papersToRIS, serializeLibraryPaper } from './readingLibrary.ts';
import { buildSavedPaperPayload } from './savedPaperPayload.ts';

const works = JSON.parse(readFileSync(new URL('./openAlexWorks.fixture.json', import.meta.url), 'utf8')) as {
  sample: OpenAlexWork[]; named: OpenAlexWork[];
};
const namedWork = (id: string) => works.named.find(work => work.id?.endsWith(id))!;

// The card the feed builds from an OpenAlex work.
const feedPaper = (work: OpenAlexWork) => PaperBuilder.deduplicate([new OpenAlexAdapter().mapToStandard(work)])[0];
const throughFirestore = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// The copies a paper comes back from, read the way the lists read them. A
// like, a read mark, Read later, a note and a save keep the interaction's
// `paper` map; the save modal also writes `savedPapers`.
const storedCopies = (paper: Paper): Array<[string, Partial<Paper>]> => [
  ['interaction copy', paperLegacyAdapter(throughFirestore(serializeLibraryPaper(paper)))],
  ['savedPapers document', paperLegacyAdapter({ id: paper.id, ...throughFirestore(buildSavedPaperPayload(paper, '2026-10-20T12:00:00.000Z')) })],
];

// PAP-60: OpenAlex files W2120490784 under Genetics, and the feed said
// Biology. The stored copy dropped the topic, and "Somatic cell nuclear
// transfer" among its concept names made the reloaded copy Physics.
test('the cat-embryo paper stays Biology in every stored copy', () => {
  const paper = feedPaper(namedWork('W2120490784'));
  assert.equal(areaLabelForPaper(paper), 'Biology');
  for (const [copy, stored] of storedCopies(paper)) {
    assert.equal(areaLabelForPaper(stored), 'Biology', copy);
  }
});

// The tester's card. Its stored copy read Computer Science only because a
// concept name contained "artificial intelligence"; the topic it came from
// was gone.
test("the AI survey stays Computer Science, and its topic's ids survive the copy", () => {
  const paper = feedPaper(namedWork('W4233888153'));
  assert.equal(areaLabelForPaper(paper), 'Computer Science');
  for (const [copy, stored] of storedCopies(paper)) {
    assert.equal(areaLabelForPaper(stored), 'Computer Science', copy);
    assert.equal(stored.primaryTopic?.id, 'https://openalex.org/T13904', copy);
    assert.equal(stored.primaryTopic?.subfield?.id, 'https://openalex.org/subfields/1702', copy);
    assert.equal(stored.primaryTopic?.field?.id, 'https://openalex.org/fields/17', copy);
  }
});

// Two works from each of ten OpenAlex fields. Before PAP-60, 9 of the 20
// interaction copies and 17 of the 20 savedPapers documents read as another
// field than the card, or as none.
test('no stored copy changes the field, its name or its ink', () => {
  for (const work of works.sample) {
    const paper = feedPaper(work);
    for (const [copy, stored] of storedCopies(paper)) {
      assert.deepEqual(
        [areaKeyForPaper(stored), areaLabelForPaper(stored), areaAccentForPaper(stored)],
        [areaKeyForPaper(paper), areaLabelForPaper(paper), areaAccentForPaper(paper)],
        `${work.id}, ${copy}`,
      );
    }
  }
});

const paper = {
  id: 'paper-1',
  title: 'A useful result',
  authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }],
  published: '2025-03-01',
  doi: '10.1234/example',
  journal: 'Journal of Tests',
};

test('serializes the metadata needed by the personal library', () => {
  const stored = serializeLibraryPaper(paper);
  assert.equal(stored.year, 2025);
  assert.equal(stored.authors.length, 2);
  assert.equal(stored.doi, '10.1234/example');
});

test('does not invent a title when the paper has none', () => {
  const stored = serializeLibraryPaper({ id: 'openalex:W1' });
  assert.equal(stored.title, '');
  assert.equal(stored.id, 'openalex:W1');
});

test('exports valid-looking BibTeX and RIS records', () => {
  const bib = papersToBibTeX([paper]);
  const ris = papersToRIS([paper]);
  assert.match(bib, /@article\{/);
  assert.match(bib, /author = \{Ada Lovelace and Alan Turing\}/);
  assert.match(ris, /TY {2}- JOUR/);
  assert.match(ris, /DO {2}- 10\.1234\/example/);
  assert.match(ris, /ER {2}-/);
});
