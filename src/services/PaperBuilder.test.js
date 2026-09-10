import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBuilder } from './PaperBuilder.js';
import { scorePaperForRecommendation } from '../utils/recommendationEngine.js';

test('normalizes category and publication metadata used by ranking', () => {
  const paper = PaperBuilder.create({
    id: 'arxiv:2607.00001',
    title: 'Optics paper',
    categories: ['physics.optics', 'quant-ph'],
    published: '2026-07-01T00:00:00Z',
    citationsCount: 12,
    authors: [{ name: 'Ada Researcher' }],
  });

  assert.equal(paper.primaryCategory, 'physics.optics');
  assert.deepEqual(paper.allCategories, ['physics.optics', 'quant-ph']);
  assert.equal(paper.published, '2026-07-01T00:00:00Z');
  assert.equal(paper.citationCount, 12);

  const score = scorePaperForRecommendation(paper, {
    now: new Date('2026-07-02T00:00:00Z').getTime(),
    userPreferences: ['physics.optics'],
    followedAuthors: ['Ada Researcher'],
  });
  assert.equal(score.preference, 100);
  assert.equal(score.authorBoost, 50);
});

test('OpenAlex enrichment remains available to the recommendation engine', () => {
  const paper = PaperBuilder.create({ id: 'arxiv:1', title: 'Paper', publicationType: 'preprint' });
  const enriched = PaperBuilder.merge(paper, {
    citationCount: 42,
    citationCountKnown: true,
    concepts: [{ id: 'concept-1', score: 0.5 }],
  }, 'openalex');

  const score = scorePaperForRecommendation(enriched, {
    conceptAffinities: { 'concept-1': 1 },
  });

  assert.equal(enriched.openAlex.citationCount, 42);
  assert.equal(enriched.citationCountKnown, true);
  assert.ok(score.citations > 0);
  assert.ok(score.semantic > 0);
});

test('keeps a confirmed zero citation count distinct from missing metadata', () => {
  const paper = PaperBuilder.create({ id: 'arxiv:2', title: 'New paper' });
  const enriched = PaperBuilder.merge(paper, {
    citationCount: 0,
    citationCountKnown: true,
  }, 'openalex');

  assert.equal(enriched.citationCount, 0);
  assert.equal(enriched.citationCountKnown, true);
});

test('does not treat an OpenAlex repository as a verified publication', () => {
  const paper = PaperBuilder.create({
    id: 'arxiv:2607.08264',
    title: 'New arXiv paper',
    publicationType: 'preprint',
    publicationStatus: 'preprint',
  });
  const enriched = PaperBuilder.merge(paper, {
    publicationType: 'repository',
    publicationStatus: 'preprint',
  }, 'openalex');

  assert.equal(enriched.publicationType, 'preprint');
  assert.equal(enriched.publicationStatus, 'preprint');
  assert.equal(enriched.peerReviewed, false);
});

test('does not mark a repository-hosted preprint as peer reviewed', () => {
  const paper = PaperBuilder.create({
    id: 'openalex:W7168054384',
    title: 'Repository preprint',
    publicationType: 'repository',
    publicationStatus: 'preprint',
  });

  assert.equal(paper.peerReviewed, false);
});

test('merging an abstract does not manufacture peer review', () => {
  // The recalculation at the end of `merge` was unconditional, so a record that
  // says outright it was not reviewed had that denial overwritten by an
  // enrichment that only carried text: `published` + a type that is not
  // `preprint` came out `peerReviewed: true`.
  const base = PaperBuilder.create({
    id: 'ads:1',
    title: 'Report',
    publicationType: 'techreport',
    publicationStatus: 'published',
    peerReviewed: false,
  });
  const merged = PaperBuilder.merge(base, { abstract: 'Now with text.' }, 'ads');

  assert.equal(merged.peerReviewed, false);
});

test('a merged twin contributes the arXiv id the base was missing', () => {
  const merged = PaperBuilder.merge(
    { id: 'openalex:W1', title: 'A paper', sources: { primary: 'openalex', enrichedBy: [] } },
    { arxivId: '2401.12345', citationCount: 30 },
    'arxiv',
  );

  assert.equal(merged.arxivId, '2401.12345');
});

test('a base that knows its own arXiv id keeps it through a merge', () => {
  const merged = PaperBuilder.merge(
    {
      id: 'arxiv:2401.00001',
      arxivId: '2401.00001',
      title: 'A preprint',
      sources: { primary: 'arxiv', enrichedBy: [] },
    },
    { arxivId: '9999.99999' },
    'openalex',
  );

  assert.equal(merged.arxivId, '2401.00001');
});

test('deduplicates the same title and author when only one source has a DOI', () => {
  const deduplicated = PaperBuilder.deduplicate([
    {
      id: 'doi-source',
      doi: '10.1000/example',
      title: 'A Shared Research Result',
      authors: [{ name: 'Ada Researcher' }],
      provider: 'openalex',
    },
    {
      id: 'metadata-source',
      title: 'A Shared Research Result',
      authors: [{ name: 'Ada Researcher' }],
      summary: 'Abstract supplied by another source.',
      provider: 'pubmed',
    },
  ]);

  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0].doi, '10.1000/example');
});

test('deduplicates provider records by a stable arXiv identifier before title matching', () => {
  const deduplicated = PaperBuilder.deduplicate([
    {
      id: 'arxiv:2607.12345v2',
      arxivId: '2607.12345v2',
      title: 'Original title',
      authors: [{ name: 'Ada Researcher' }],
      provider: 'arxiv',
    },
    {
      id: 'hf-paper',
      huggingFaceId: '2607.12345',
      arxivId: '2607.12345',
      title: 'Revised title from the Hub',
      authors: [{ name: 'Ada Researcher' }],
      huggingFaceUpvotes: 12,
      provider: 'huggingface',
    },
  ]);

  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0].huggingFaceUpvotes, 12);
  assert.ok(deduplicated[0].sources.enrichedBy.includes('huggingface'));
});

test('deduplication keeps the citation count whichever source comes first', () => {
  // Adapters speak `citationsCount`; only `create` translates it. A raw duplicate
  // reaching `merge` as the enrichment carried its count in the name `merge`
  // never read, so arXiv-then-OpenAlex ended on a confirmed zero while
  // OpenAlex-then-arXiv kept the 250.
  const arx = PaperBuilder.create({
    id: 'arxiv:2401.00001',
    title: 'Same',
    authors: [{ name: 'A' }],
    sources: { primary: 'arxiv', enrichedBy: [] },
  });
  const oa = {
    id: 'W1',
    title: 'Same',
    authors: [{ name: 'A' }],
    arxivId: '2401.00001',
    citationsCount: 250,
    provider: 'openalex',
    sources: { primary: 'openalex', enrichedBy: [] },
  };

  const [merged] = PaperBuilder.deduplicate([arx, oa]);
  assert.equal(merged.citationCount, 250);
  assert.equal(merged.citationCountKnown, true);
});

test('fills a missing abstract from the OpenAlex enrichment that already runs', () => {
  // Half of NASA's records and a tenth of Europe PMC's arrive without one, and a
  // card whose body reads "Resumen no disponible" is dead weight in a feed you
  // navigate by swiping.
  const paper = PaperBuilder.create({ id: 'nasa:1', title: 'A record without an abstract' });
  assert.equal(paper.abstract, 'No abstract available.');

  const merged = PaperBuilder.merge(paper, { abstract: 'The abstract OpenAlex had.' }, 'openalex');
  assert.equal(merged.abstract, 'The abstract OpenAlex had.');
  assert.equal(merged.summary, 'The abstract OpenAlex had.');
});

test('never overwrites an abstract the source already supplied', () => {
  // The publisher's own text beats a rebuild of an inverted index.
  const paper = PaperBuilder.create({ id: 'arxiv:1', abstract: 'The text arXiv shipped.' });
  const merged = PaperBuilder.merge(paper, { abstract: 'The rebuilt OpenAlex one.' }, 'openalex');
  assert.equal(merged.abstract, 'The text arXiv shipped.');
});

test('leaves the placeholder alone when the enrichment has nothing either', () => {
  const paper = PaperBuilder.create({ id: 'nasa:2' });
  assert.equal(PaperBuilder.merge(paper, { abstract: '' }, 'openalex').abstract, 'No abstract available.');
  assert.equal(PaperBuilder.merge(paper, {}, 'openalex').abstract, 'No abstract available.');
  // A placeholder arriving from the other side must not be mistaken for text.
  assert.equal(
    PaperBuilder.merge(paper, { abstract: 'Resumen no disponible.' }, 'openalex').abstract,
    'No abstract available.',
  );
});

test('OpenAlex ids are grafted onto the authors a card already shows, without touching the names', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    sources: { primary: 'arxiv', enrichedBy: [] },
    authors: [
      { name: 'Nicolás Cuello', id: null, affiliation: null },
      { name: 'Mario Sucerquia', id: null, affiliation: null },
    ],
  });

  const merged = PaperBuilder.merge(base, {
    authors: [
      // OpenAlex writes the same people differently, and out of order.
      { name: 'Sucerquia, M.', id: 'https://openalex.org/A2' },
      { name: 'Nicolas Cuello', id: 'https://openalex.org/A1' },
    ],
  }, 'openalex');

  assert.deepEqual(merged.authors, [
    { name: 'Nicolás Cuello', id: 'https://openalex.org/A1', affiliation: null },
    { name: 'Mario Sucerquia', id: 'https://openalex.org/A2', affiliation: null },
  ], 'the card keeps its own spelling and order, and gains the id');
});

test('an author OpenAlex does not name, or does not disambiguate, is left as it was', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Ada Lovelace', id: null }, { name: 'Grace Hopper', id: null }],
  });

  const merged = PaperBuilder.merge(base, {
    authors: [
      { name: 'Ada Lovelace', id: null },
      { name: 'Someone Else', id: 'https://openalex.org/A9' },
    ],
  }, 'openalex');

  assert.deepEqual(merged.authors, [{ name: 'Ada Lovelace', id: null }, { name: 'Grace Hopper', id: null }]);
});

/**
 * Two co-authors sharing a surname and an initial. `matchesAuthorName` lets an
 * initial match any part starting with that letter, so a first-match `find`
 * handed BOTH of them the first "Wang, J." — executed against the real matcher
 * during the 2026-09-09 review — and the id door opened the other person's
 * page with no name check downstream. arXiv and OpenAlex list the same work in
 * the same order, so when the two lists are the same length the position is
 * the identity; otherwise only a UNIQUE name match may carry an id.
 */
test('co-authors sharing a surname get their own ids, by position', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Jing Wang', id: null }, { name: 'Jun Wang', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Wang, J.', id: 'https://openalex.org/A1' }, { name: 'Wang, J.', id: 'https://openalex.org/A2' }],
  }, 'openalex');
  assert.deepEqual(merged.authors.map((a) => a.id), ['https://openalex.org/A1', 'https://openalex.org/A2']);
});

test('when the lists differ in length, an ambiguous name carries no id', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'J. Smith', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [
      { name: 'John Smith', id: 'https://openalex.org/A1' },
      { name: 'Jane Smith', id: 'https://openalex.org/A2' },
      { name: 'Grace Hopper', id: 'https://openalex.org/A3' },
    ],
  }, 'openalex');
  assert.equal(merged.authors[0].id, null, 'two Smiths match: the door stays the slow one rather than the wrong one');
});

test('a position that does not match the name falls back to a unique match', () => {
  // Same length, but OpenAlex lists them in the other order.
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Ada Lovelace', id: null }, { name: 'Grace Hopper', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Hopper, G.', id: 'https://openalex.org/A2' }, { name: 'Lovelace, A.', id: 'https://openalex.org/A1' }],
  }, 'openalex');
  assert.deepEqual(merged.authors.map((a) => a.id), ['https://openalex.org/A1', 'https://openalex.org/A2']);
});

test('an id the paper already carries is never overwritten by the enrichment', () => {
  const base = PaperBuilder.create({
    id: 'openalex:W1',
    authors: [{ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }],
  });

  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'A. Lovelace', id: 'https://openalex.org/A999' }],
  }, 'openalex');

  assert.equal(merged.authors[0].id, 'https://openalex.org/A1');
});

test('a paper that arrives with no authors takes the enrichment list whole', () => {
  const base = PaperBuilder.create({ id: '2609.05134', authors: [] });

  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }],
  }, 'openalex');

  assert.deepEqual(merged.authors, [{ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }]);
});

test('enrichment without authors leaves the list alone', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Ada Lovelace', id: null }],
  });

  const merged = PaperBuilder.merge(base, { citationCount: 4 }, 'openalex');
  assert.deepEqual(merged.authors, [{ name: 'Ada Lovelace', id: null }]);
});
