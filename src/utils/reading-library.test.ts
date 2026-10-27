import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Paper } from '../models/paper.ts';
import type { OpenAlexWork } from '../services/adapters/open-alex-types.ts';
import { paperLegacyAdapter, storedClassification } from '../models/paper.ts';
import { OpenAlexAdapter } from '../services/adapters/open-alex-adapter.ts';
import { mapEuropePmcSearchResult } from '../services/domain-source-records.ts';
import { mapOpenAlexEnrichmentWork, mapOpenAlexWork } from '../utils/open-alex-work.ts';
import { PaperBuilder } from '../services/paper-builder.ts';
import { areaAccentForPaper, areaKeyForPaper, areaLabelForPaper } from './area-accent.ts';
import { cardsGivenTopic, getOpenAlexEnrichmentId, mergeFeedAbstracts, mergeOpenAlexEnrichment } from './feed-enrichment.ts';
import { hydrateSeededPaper } from './paper-seed.ts';
import { abstractExcerpt, papersToBibTeX, papersToRIS, serializeLibraryPaper } from './reading-library.ts';
import { buildSavedPaperPayload } from './saved-paper-payload.ts';
import { sourceAttribution } from './source-attribution.ts';

const works = JSON.parse(readFileSync(new URL('./open-alex-works.fixture.json', import.meta.url), 'utf8')) as {
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
test("the AI survey stays Artificial Intelligence, and its topic's ids survive the copy", () => {
  const paper = feedPaper(namedWork('W4233888153'));
  assert.equal(areaLabelForPaper(paper), 'Artificial Intelligence');
  for (const [copy, stored] of storedCopies(paper)) {
    assert.equal(areaLabelForPaper(stored), 'Artificial Intelligence', copy);
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

type StoredFields = Record<string, unknown>;
const isMap = (value: unknown): value is StoredFields => typeof value === 'object' && value !== null && !Array.isArray(value);
// What setDoc(ref, data, { merge: true }) leaves: a field sent replaces the
// stored one, a map merges key by key, and a field not sent stays.
const mergeIntoStored = (stored: StoredFields, sent: StoredFields): StoredFields => {
  const merged = { ...stored };
  for (const [key, value] of Object.entries(sent)) {
    const before = merged[key];
    merged[key] = isMap(value) && isMap(before) ? mergeIntoStored(before, value) : value;
  }
  return merged;
};

// Every write of a stored copy merges into the document already there: the
// save modal on each new list, Undo after an unsave, and a like, save or read
// into the interaction's copy. A copy from before PAP-60 kept the category its
// card showed, here the hep-th the tester saw on the AI survey. A new write
// that leaves the category out keeps it, now under a classificationVersion,
// and the copy read Physics where the card said Computer Science.
test('a save over a copy stored before PAP-60 reads as the card does', () => {
  const paper = feedPaper(namedWork('W4233888153'));
  const savedPapers = mergeIntoStored(
    { title: paper.title, primaryCategory: 'hep-th', savedAt: '2026-10-01T12:00:00.000Z' },
    throughFirestore(buildSavedPaperPayload(paper, '2026-10-21T12:00:00.000Z')),
  );
  assert.equal(areaLabelForPaper(paperLegacyAdapter({ id: paper.id, ...savedPapers })), 'Artificial Intelligence', 'savedPapers document');

  const interaction = mergeIntoStored(
    { liked: true, paper: { id: paper.id, title: paper.title, primaryCategory: 'hep-th', categories: ['hep-th'] } },
    { saved: true, paper: throughFirestore(serializeLibraryPaper(paper)) },
  );
  assert.equal(areaLabelForPaper(paperLegacyAdapter(interaction.paper as Partial<Paper>)), 'Artificial Intelligence', 'interaction copy');
});

// PAP-60, D6. Past the first page, OpenAlex answers after a card is shown,
// and a card from a source with no classification of its own, as Europe PMC
// serves one, takes its field from that answer. A like or a save before it
// stored the card without the topic: the card said Biology and the copies,
// reloaded, said nothing.
test('a paper liked and saved before OpenAlex answered keeps the field the answer gave its card', () => {
  const work = namedWork('W2120490784');
  // Europe PMC's record of the same paper. Only the DOI is real.
  const shown = mapEuropePmcSearchResult({
    id: '1', source: 'MED', pmid: '1', doi: work.doi!, title: work.title!, firstPublicationDate: '2002-11-01',
  })!;
  const enriched = mergeOpenAlexEnrichment([shown], { [getOpenAlexEnrichmentId(shown)]: mapOpenAlexEnrichmentWork(work)!.enrichment });
  assert.equal(areaLabelForPaper(shown), null);
  assert.equal(areaLabelForPaper(enriched[0]), 'Biology');

  const liked = { liked: true, saved: true, paper: throughFirestore(serializeLibraryPaper(shown)) };
  const saved = throughFirestore(buildSavedPaperPayload(shown, '2026-10-21T12:00:00.000Z'));
  const [card, ...others] = cardsGivenTopic([shown], enriched);
  assert.equal(card, enriched[0]);
  assert.deepEqual(others, []);
  assert.deepEqual(cardsGivenTopic(enriched, enriched), [], 'a card that already had its topic is not written again');

  // What the feed writes for the card: the topic, as a copy keeps it, into
  // each stored copy that has none, and nothing else.
  const { primaryTopic } = storedClassification(card);
  const likedAfter = mergeIntoStored(liked, { paper: { primaryTopic } });
  const savedAfter = mergeIntoStored(saved, { primaryTopic });
  assert.equal(areaLabelForPaper(paperLegacyAdapter(likedAfter.paper as Partial<Paper>)), 'Biology', 'interaction copy');
  assert.equal(areaLabelForPaper(paperLegacyAdapter({ id: shown.id, ...savedAfter })), 'Biology', 'savedPapers document');

  // The save sheet still holds the card as it was first shown; saving it to
  // another list must not take the field away again.
  const savedAgain = mergeIntoStored(savedAfter, throughFirestore(buildSavedPaperPayload(shown, '2026-10-21T12:05:00.000Z')));
  assert.equal(areaLabelForPaper(paperLegacyAdapter({ id: shown.id, ...savedAgain })), 'Biology', 'savedPapers document, saved again');

  // A document saved before PAP-60 carries the category the feed asked for
  // and no classificationVersion. The topic must not make that category
  // evidence: the document keeps its version, so the stamp is still dropped.
  const stamped = mergeIntoStored({ title: shown.title, primaryCategory: 'physics.bio-ph', savedAt: '2026-10-01T12:00:00.000Z' }, { primaryTopic });
  assert.equal(areaLabelForPaper(paperLegacyAdapter({ id: shown.id, ...stamped })), 'Biology', 'savedPapers document from before PAP-60');
});

// ENG-109. The Worker recovered this journal article's abstract from Semantic
// Scholar or Crossref, and the card credits that source. Liked, saved or put
// in a list, the paper opens from there on its stored copy laid over
// OpenAlex's record, which still has no abstract: the page showed the
// recovered text and credited no one.
test('a paper opened from a stored copy credits the source of the abstract its card showed', () => {
  const work = { id: 'https://openalex.org/W4410000002', doi: 'https://doi.org/10.5555/recovered', title: 'A journal article OpenAlex lists without its abstract', type: 'article', publication_date: '2026-10-20' };
  const openAlex = PaperBuilder.create(mapOpenAlexWork(work)!);
  const text = 'The abstract this source holds for the journal article, in full.';
  for (const [source, name] of [['semanticscholar', 'Semantic Scholar'], ['crossref', 'Crossref']] as const) {
    const [card] = mergeFeedAbstracts([openAlex], [{ doi: '10.5555/recovered', abstract: text, sources: { primary: source, enrichedBy: [] } }]);
    assert.deepEqual([sourceAttribution(card)?.label, sourceAttribution(card)?.name], ['Abstract:', name], 'the card');
    for (const [copy, stored] of storedCopies(card)) {
      const page = hydrateSeededPaper(stored, openAlex);
      assert.equal(page?.abstract, text, `${source}, ${copy}`);
      assert.deepEqual([sourceAttribution(page)?.label, sourceAttribution(page)?.name], ['Abstract:', name], `${source}, ${copy}`);
    }
  }
});

test("a stored copy credits no source for a text the source did not supply", () => {
  const recovered = 'The abstract Semantic Scholar holds for this paper, in full.';
  const card = { id: 'openalex:W4410000002', title: 'A journal article', abstract: recovered, abstractSource: 'semanticscholar' as const };
  // The copy keeps the summary where one was built, which is another text.
  const summarised = { ...card, summary: 'A summary another source wrote for this paper.' };
  assert.equal('abstractSource' in serializeLibraryPaper(summarised), false, 'interaction copy');
  assert.equal('abstractSource' in buildSavedPaperPayload(summarised, '2026-10-20T12:00:00.000Z'), false, 'savedPapers document');
  // A value no card credits, as a document could hold it, credits no one.
  for (const abstractSource of ['openalex', 'Semantic Scholar', '', null]) {
    const stored: Partial<Paper> = paperLegacyAdapter(JSON.parse(JSON.stringify({ id: card.id, title: card.title, summary: recovered, abstractSource })));
    assert.equal(stored.abstractSource, undefined, String(abstractSource));
  }
  // A copy without text credits no one for the placeholder it shows.
  assert.equal(paperLegacyAdapter({ id: card.id, title: card.title, abstractSource: 'semanticscholar' }).abstractSource, undefined);
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

test('a library copy takes its summary from the abstract when the row has none', () => {
  assert.equal(serializeLibraryPaper({ id: 'x', abstract: 'The abstract.' }).summary, 'The abstract.');
  assert.equal(serializeLibraryPaper({ id: 'x', summary: 'An older copy.' }).summary, 'An older copy.');
});

test('an interaction excerpt reads the abstract and is cut at 500 characters', () => {
  assert.equal(abstractExcerpt({ abstract: 'a'.repeat(600) }).length, 500);
  assert.equal(abstractExcerpt({ summary: 'kept' }), 'kept');
  assert.equal(abstractExcerpt({}), '');
});

test('a RIS record carries the abstract of a served card, and no placeholder', () => {
  assert.match(papersToRIS([{ title: 'A paper', abstract: 'The abstract.' }]), /^AB {2}- The abstract\.$/m);
  assert.doesNotMatch(papersToRIS([{ title: 'A paper', abstract: 'No abstract available.' }]), /^AB /m);
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
