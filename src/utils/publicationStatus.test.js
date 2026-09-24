import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  arxivCommentSaysPublished,
  openAlexPublicationStatus,
  semanticScholarIsPreprint,
} from './publicationStatus.js';

// Chapters and accepted papers labelled «Preprint» (audit 2026-09-23, issue
// 12a): of 31 recent chapters in the guest's six computing categories, 23
// carried the chip, and about 16 said in their own arXiv comment that they
// were accepted or published.

test('an arXiv comment that says the paper is accepted or out makes it published', () => {
  for (const comment of [
    // Measured: 2607.02734, 2608.12077, 2606.06074.
    'Accepted for publication as a book chapter (Taylor & Francis, 2026)',
    'To appear as a chapter in the book "Foundations of Robot Learning"',
    'Accepted at the 40th AAAI Conference on Artificial Intelligence',
    // The phrasings the rule already read.
    'Accepted in IEEE Transactions on Pattern Analysis and Machine Intelligence',
    'Published in Nature Physics 21, 1203 (2025)',
    'Appears in Proceedings of the 42nd International Conference on Machine Learning',
    'To appear in ICML 2026',
    // Same meaning, other prepositions.
    'Accepted to CVPR 2026. Code is available',
    'To appear at ICRA 2026',
  ]) {
    assert.equal(arxivCommentSaysPublished(comment), true, comment);
  }
});

test('an arXiv comment that only describes or submits the paper leaves it a preprint', () => {
  for (const comment of [
    'Submitted to NeurIPS 2026',
    'Under review at ICLR 2027',
    '12 pages, 5 figures',
    'Preprint. Work in progress',
    '',
    null,
  ]) {
    assert.equal(arxivCommentSaysPublished(comment), false, String(comment));
  }
});

test('an OpenAlex work is a preprint by its type, not by where its best copy sits', () => {
  // 8 in 100 random chapters had a repository as primary location, and were
  // labelled preprints for it.
  const repository = { is_published: false, source: { type: 'repository' } };
  assert.equal(openAlexPublicationStatus({ type: 'book-chapter', primary_location: repository }), 'published');
  assert.equal(openAlexPublicationStatus({ type: 'article', primary_location: repository }), 'published');
  assert.equal(openAlexPublicationStatus({ type: 'preprint', primary_location: repository }), 'preprint');
  assert.equal(openAlexPublicationStatus({ type: 'posted-content' }), 'preprint');
  assert.equal(openAlexPublicationStatus({ type: 'Book-Chapter' }), 'published');
});

test('a work typed as a preprint is published once any copy of it is the published one', () => {
  // The enrichment mapper's rule, which the card mappers now share: a later
  // journal version is evidence, and dropping it would label the paper wrongly
  // the other way.
  assert.equal(openAlexPublicationStatus({ type: 'preprint', primary_location: { is_published: true } }), 'published');
  assert.equal(
    openAlexPublicationStatus({ type: 'preprint', locations: [{ is_published: false }, { is_published: true }] }),
    'published',
  );
});

test('an OpenAlex work with no type falls back on whether any copy is published', () => {
  assert.equal(openAlexPublicationStatus({ primary_location: { is_published: true } }), 'published');
  assert.equal(openAlexPublicationStatus({ locations: [{ is_published: false }, { is_published: true }] }), 'published');
  assert.equal(openAlexPublicationStatus({ primary_location: { is_published: false } }), 'preprint');
  assert.equal(openAlexPublicationStatus(null), 'preprint');
});

test('a Semantic Scholar review is an article, not a preprint', () => {
  // PMID 30617335, a Nature Medicine review, carried the chip.
  assert.equal(semanticScholarIsPreprint(['Review', 'JournalArticle']), false);
  assert.equal(semanticScholarIsPreprint(['Review']), false);
  assert.equal(semanticScholarIsPreprint(['Preprint']), true);
  assert.equal(semanticScholarIsPreprint(['preprint']), true);
  assert.equal(semanticScholarIsPreprint(undefined), false);
});

// The four mappers use the rules above (convention ce139ce: comments stripped).
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = path => readFile(new URL(path, import.meta.url), 'utf8').then(stripComments);

test('SOURCE: arXiv, OpenAlex and Semantic Scholar mappers read their status from these rules', async () => {
  const arxiv = await read('../services/arxivService.js');
  assert.match(arxiv, /const isPublishedInArxiv = !!\(doi \|\| journalRef \|\| arxivCommentSaysPublished\(comment\)\);/);

  const service = await read('../services/openAlexService.js');
  const format = service.slice(service.indexOf('function formatOpenAlexWorkAsPaper('), service.indexOf('function formatOpenAlexWorkAsPaper(') + 3000);
  assert.match(format, /publicationStatus: openAlexPublicationStatus\(work\),/);
  const enrichment = service.slice(service.indexOf('export function mapOpenAlexEnrichmentWork('), service.indexOf('export function mapOpenAlexEnrichmentWork(') + 3000);
  assert.match(enrichment, /publicationStatus: openAlexPublicationStatus\(work\),/);

  const adapter = await read('../services/adapters/OpenAlexAdapter.js');
  assert.match(adapter, /const publicationStatus = openAlexPublicationStatus\(work\);/);

  const s2 = await read('../services/adapters/SemanticScholarAdapter.js');
  assert.match(s2, /const isPreprint = semanticScholarIsPreprint\(raw\.publicationTypes\);/);
  assert.doesNotMatch(s2, /includes\('review'\)/);
});
