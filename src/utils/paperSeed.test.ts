import type { PaperAuthor } from '../models/Paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateSeededPaper, hydratedAbstract, hydratedAuthors, seedPaintsWhole } from './paperSeed.ts';
import { LEGACY_STORED_SUMMARY_CAP, STORED_AUTHOR_CAP, STORED_SUMMARY_CAP } from './readingLibrary.ts';

test('a handed-over copy paints only when it carries a title and a real abstract', () => {
  assert.equal(seedPaintsWhole({ title: 'T', abstract: 'Despite growing interest in open access…' }), true);
  assert.equal(seedPaintsWhole({ title: 'T', abstract: 'No abstract available.' }), false,
    'the legacy adapter\'s placeholder is not an abstract');
  assert.equal(seedPaintsWhole({ title: 'T', abstract: 'Resumen no disponible.' }), false);
  assert.equal(seedPaintsWhole({ title: 'T', abstract: '' }), false);
  assert.equal(seedPaintsWhole({ title: 'T' }), false);
  assert.equal(seedPaintsWhole({ title: '', abstract: 'Words.' }), false);
  assert.equal(seedPaintsWhole(null), false);
});

/**
 * The paper page hydrates a stored copy from the providers, and the provider
 * that answers a DOI is OpenAlex — which files the same paper under another
 * branch, prints the authors its own way and carries its own abstract, under
 * its own id. The hydrated paper is the provider's, with the copy laid over
 * it where the copy speaks.
 */
const seed = {
  id: 'openalex:W77',
  title: 'Neuromimetic Circuits with Synaptic Devices Based on Strongly Correlated Electron Systems',
  authors: [{ name: 'Ha, Sieu D.' }, { name: 'Shi, Jian' }, { name: 'Meroz, Yasmine' }],
  abstract: 'Strongly correlated electron systems such as the rare-earth nickelates can exhibit synapselike behaviour.',
  primaryCategory: 'cond-mat.str-el',
  categories: ['cond-mat.str-el', 'cs.ET', 'q-bio.NC'],
  doi: '10.1103/PhysRevApplied.2.064003',
  journal: 'Physical Review Applied',
  year: 2014,
  sources: { primary: 'stored', enrichedBy: [] },
};
const provider = {
  id: 'W77',
  title: 'Neuromimetic circuits with synaptic devices based on strongly correlated electron systems',
  authors: [{ name: 'Sieu D. Ha', id: 'https://openalex.org/A1' }, { name: 'Jian Shi' }, { name: 'Yasmine Meroz' }],
  abstract: 'A crucial feature of biological neural architectures is their ability to learn, and unlearn.',
  categories: ['Electronic circuit', 'Feature (linguistics)'],
  concepts: [({ display_name: 'Electronic circuit' } as import('../models/Paper.ts').PaperSubject & Record<string, unknown>)],
  primaryTopic: ({ field: { display_name: 'Electrical & Electronic Engineering' } } as import('../models/Paper.ts').PaperSubject),
  doi: 'https://doi.org/10.1103/physrevapplied.2.064003',
  year: 2014,
  published: '2014-12-01',
  citationCount: 58,
  citationCountKnown: true,
  openAccess: true,
  pdfUrl: 'https://arxiv.org/pdf/1411.0000',
  institutions: [{ displayName: 'Harvard' }],
  sources: { primary: 'openalex', enrichedBy: [] },
};

test('the hydrated paper is the provider\'s, keyed and filed as the copy was', () => {
  const paper = hydrateSeededPaper(seed, provider);
  assert.equal(paper!.id, 'openalex:W77', 'the id the read mark and the like are keyed by');
  assert.equal(paper!.primaryCategory, 'cond-mat.str-el', 'the branch the feed filed it under');
  assert.deepEqual(paper!.categories, ['cond-mat.str-el', 'cs.ET', 'q-bio.NC']);
  assert.deepEqual(paper!.authors!.map((a) => (a as PaperAuthor).name), ['Ha, Sieu D.', 'Shi, Jian', 'Meroz, Yasmine'], 'as the reader saw them');
  assert.equal(paper!.abstract, seed.abstract, 'the text the reader read in the feed');
  assert.equal(paper!.title, seed.title);
  assert.equal(paper!.doi, seed.doi);
  assert.equal(paper!.journal, 'Physical Review Applied');
  assert.equal(paper!.citationCount, 58, 'what the copy never carried comes from the provider');
  assert.equal(paper!.openAccess, true);
  assert.equal(paper!.pdfUrl, provider.pdfUrl, 'a link the copy lacked is filled in');
  assert.deepEqual(paper!.institutions, provider.institutions);
  assert.deepEqual(paper!.concepts, provider.concepts);
  assert.equal(paper!.published, '2014-12-01', 'the date is taken fresh');
  assert.equal(paper!.sources!.primary, 'openalex');
});

test('the copy only lays over the provider where it speaks', () => {
  const thin = { id: 'arxiv:2401.12345', title: 'T', authors: [], abstract: 'No abstract available.', categories: [] };
  const paper = hydrateSeededPaper(thin, provider);
  assert.equal(paper!.id, 'arxiv:2401.12345');
  assert.deepEqual(paper!.authors, provider.authors);
  assert.equal(paper!.abstract, provider.abstract, 'the placeholder is not an abstract');
  assert.deepEqual(paper!.categories, provider.categories);
  assert.equal(paper!.primaryCategory, undefined);
  assert.equal(hydrateSeededPaper(null, provider), provider);
  assert.equal(hydrateSeededPaper(seed, null), seed, 'no answer: the copy is the paper, as before');
});

test('a whole stored abstract stays; one cut at the cap gives way to the provider\'s', () => {
  const whole = 'W'.repeat(LEGACY_STORED_SUMMARY_CAP - 1);
  assert.equal(hydratedAbstract(whole, 'Provider text.'), whole);
  const cutLegacy = 'L'.repeat(LEGACY_STORED_SUMMARY_CAP);
  assert.equal(hydratedAbstract(cutLegacy, 'Provider text.'), 'Provider text.', 'cut at the old cap');
  const cutNow = 'N'.repeat(STORED_SUMMARY_CAP);
  assert.equal(hydratedAbstract(cutNow, 'Provider text.'), 'Provider text.', 'cut at the current cap');
  assert.equal(hydratedAbstract(cutNow, 'Resumen no disponible.'), cutNow, 'a cut text still beats no text');
  assert.equal(hydratedAbstract('No abstract available.', 'Provider text.'), 'Provider text.');
  assert.equal(hydratedAbstract('', ''), '');
});

test('the stored authors stay unless the copy was cut and the provider knows more', () => {
  const few = [{ name: 'A' }, { name: 'B' }];
  const more = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  assert.equal(hydratedAuthors(few, more), few, 'a short list was not cut; it is how the feed printed them');
  const capped = Array.from({ length: STORED_AUTHOR_CAP }, (_, i) => ({ name: `A${i}` }));
  const all = [...capped, { name: 'Z' }];
  assert.equal(hydratedAuthors(capped, all), all);
  assert.equal(hydratedAuthors(capped, capped.slice(0, 5)), capped, 'the provider knowing fewer is no reason to drop any');
  assert.equal(hydratedAuthors([], more), more);
});
