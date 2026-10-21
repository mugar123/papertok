import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Paper } from '../models/Paper.ts';
import type { OpenAlexWork } from './adapters/openAlexTypes.ts';
import { getCategoryLabel } from '../data/categoryTaxonomy.ts';
import { OpenAlexAdapter } from './adapters/OpenAlexAdapter.ts';
import { noteLabelSearchCategories } from './arxivService.ts';
import { PaperBuilder } from './PaperBuilder.ts';

interface ArxivEntry { id: string; title: string; primaryCategory: string; categories: string[] }
interface Pair { arxiv: ArxivEntry; openAlex: OpenAlexWork }

// Saved by the 2026-10-20 classification audit (PAP-64): arXiv entries fetched
// by id_list, each beside the OpenAlex work that locates the same eprint,
// trimmed to the fields the OpenAlex mapper reads and three concepts a work.
// `example` is 2605.02209, the paper in the report: cs.AI with a cs.LG
// cross-list on arXiv.
const fixture = JSON.parse(readFileSync(new URL('./arxivOpenAlexPairs.fixture.json', import.meta.url), 'utf8')) as {
  example: Pair; pairs: Pair[];
};

// The record `parseArxivXml` builds from an entry.
function arxivRecord(entry: ArxivEntry): Paper {
  return PaperBuilder.create({
    id: entry.id,
    arxivId: entry.id,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title: entry.title,
    publicationType: 'preprint',
    publicationStatus: 'preprint',
    openAccess: true,
    landingPageUrl: `https://arxiv.org/abs/${entry.id}`,
    categories: entry.categories,
    keywords: entry.categories,
    primaryCategory: entry.primaryCategory,
  });
}

const classification = (paper: Partial<Paper>) => ({
  primaryCategory: paper.primaryCategory,
  categories: paper.categories,
  allCategories: paper.allCategories,
});
const arxivClassification = (entry: ArxivEntry) => ({
  primaryCategory: entry.primaryCategory,
  categories: entry.categories,
  allCategories: entry.categories,
});

// Every category of a cross-listed paper matches a `cat:` request exactly, so
// the first requested one won the tie and replaced the paper's own primary.
test('an arXiv paper keeps its own primary category whichever requested category found it', () => {
  const entries = [fixture.example, ...fixture.pairs].map(({ arxiv }) => arxiv);
  assert.equal(entries.filter(entry => entry.categories.length > 1).length, 36, 'cross-listed papers in the fixture');
  const replaced: string[] = [];
  for (const arxiv of entries) {
    const secondaries = arxiv.categories.filter(category => category !== arxiv.primaryCategory);
    const requests = [
      [arxiv.primaryCategory, ...secondaries],
      [...secondaries].reverse().concat(arxiv.primaryCategory),
      ...(secondaries.length ? [secondaries] : []),
    ];
    for (const requested of requests) {
      const [paper] = noteLabelSearchCategories([arxivRecord(arxiv)], requested);
      if (!isDeepStrictEqual(classification(paper), arxivClassification(arxiv))) {
        replaced.push(`${arxiv.id} asked as [${requested}] became ${paper.primaryCategory} [${paper.allCategories}]`);
      }
    }
  }
  assert.deepEqual(replaced, []);
});

test('an arXiv paper merged with its OpenAlex record keeps the arXiv categories whichever record comes first', () => {
  assert.equal(fixture.pairs.length, 74);
  const adapter = new OpenAlexAdapter();
  const lost: string[] = [];
  for (const { arxiv, openAlex } of fixture.pairs) {
    const openAlexRecord = adapter.mapToStandard(openAlex)!;
    const orders: Array<[string, Paper[]]> = [
      ['OpenAlex first', [openAlexRecord, arxivRecord(arxiv)]],
      ['arXiv first', [arxivRecord(arxiv), openAlexRecord]],
    ];
    for (const [order, records] of orders) {
      const merged = PaperBuilder.deduplicate(records);
      assert.equal(merged.length, 1, `${arxiv.id} ${order} is one paper`);
      const [paper] = merged;
      if (!isDeepStrictEqual(classification(paper), arxivClassification(arxiv))) {
        lost.push(`${arxiv.id} ${order}: ${paper.primaryCategory} instead of ${arxiv.primaryCategory}`);
      }
      // OpenAlex's own evidence stays beside the arXiv categories.
      assert.deepEqual(paper.concepts, openAlexRecord.concepts, `${arxiv.id} ${order} concepts`);
      assert.deepEqual(paper.primaryTopic, openAlexRecord.primaryTopic, `${arxiv.id} ${order} topic`);
      assert.equal(paper.citationCount, openAlex.cited_by_count, `${arxiv.id} ${order} citations`);
    }
  }
  assert.deepEqual(lost, []);
});

test('2605.02209 shows Artificial Intelligence through discovery and either merge order', () => {
  const { arxiv, openAlex } = fixture.example;
  const openAlexRecord = new OpenAlexAdapter().mapToStandard(openAlex)!;
  assert.equal(openAlexRecord.categories?.[0], 'Mutual information', 'OpenAlex files it under a concept');

  for (const requested of [['cs.LG'], ['cs.LG', 'cs.AI'], ['cs.AI', 'cs.LG']]) {
    const [discovered] = noteLabelSearchCategories([arxivRecord(arxiv)], requested);
    for (const records of [[openAlexRecord, discovered], [discovered, openAlexRecord]]) {
      const [paper] = PaperBuilder.deduplicate(records);
      assert.deepEqual(classification(paper), {
        primaryCategory: 'cs.AI',
        categories: ['cs.AI', 'cs.LG'],
        allCategories: ['cs.AI', 'cs.LG'],
      }, `asked as [${requested}], ${records[0] === openAlexRecord ? 'OpenAlex' : 'arXiv'} first`);
      assert.equal(getCategoryLabel(paper.primaryCategory!), 'Artificial Intelligence');
      assert.ok(paper.concepts?.some(concept => concept.display_name === 'Mutual information'));
    }
  }
});

test('a record that brings no arXiv classification leaves the categories alone', () => {
  const openAlexRecord = PaperBuilder.create(new OpenAlexAdapter().mapToStandard(fixture.example.openAlex)!);
  const before = classification(openAlexRecord);

  // The abstract recovery in feedEnrichment.ts merges arXiv's text alone.
  const recovered = PaperBuilder.merge(openAlexRecord, { abstract: 'A recovered abstract long enough to be usable.' }, 'arxiv');
  assert.deepEqual(classification(recovered), before);

  // Whatever category another source's record names, it is not arXiv's.
  const huggingFace = PaperBuilder.merge(openAlexRecord, {
    arxivId: '2605.02209',
    sources: { primary: 'huggingface', enrichedBy: [] },
    primaryCategory: 'cs.CL',
    categories: ['cs.CL'],
  }, 'huggingface');
  assert.deepEqual(classification(huggingFace), before);
});
