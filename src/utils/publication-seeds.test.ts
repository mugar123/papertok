import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { formatOpenAlexWorkAsPaper } from './open-alex-work.ts';
import {
  feedSeedsFrom, feedSeedsStale, isOwnWork, OWN_WORK_KEYS_MAX, paperMatchKeys, PUBLICATION_SEEDS_MAX,
  PUBLICATION_SEEDS_STALE_MS, publicationCategory, publicationSeedAllowance, sameFeedSeeds, workerCanLookUp,
} from './publication-seeds.ts';

// Synthetic OpenAlex works, as My profile reads the reader's publications.
const topic = (id: string, field: number) => ({
  id: 'https://openalex.org/' + id, display_name: 'Topic', field: { id: 'https://openalex.org/fields/' + field, display_name: 'Field' },
});
const work = (id: number, extra: Record<string, unknown> = {}) => formatOpenAlexWorkAsPaper({ id: 'https://openalex.org/W' + id, ...extra }, true);

test('a work of the reader matches the same paper from another provider', () => {
  const own = work(1, { doi: 'https://doi.org/10.1000/ABC', ids: { doi: 'https://doi.org/10.1000/ABC' } });
  const keys = new Set(feedSeedsFrom([own, { id: '2401.12345v2' }]).keys);
  // The corpus's copy of the journal article, by its DOI spelled another way.
  assert.equal(isOwnWork({ id: 'openalex:W99', doi: '10.1000/abc' }, keys), true);
  // The arXiv preprint, by its id with or without a version.
  assert.equal(isOwnWork({ id: '2401.12345' }, keys), true);
  assert.equal(isOwnWork({ id: 'x', arxivId: 'arXiv:2401.12345v1' }, keys), true);
  // OpenAlex's own id, in either spelling.
  assert.equal(isOwnWork({ id: 'https://openalex.org/W1' }, keys), true);
  assert.equal(isOwnWork({ id: '2401.54321', doi: '10.1000/other' }, keys), false);
  assert.equal(isOwnWork({ id: '2401.12345' }, new Set()), false);
  assert.deepEqual(paperMatchKeys({ id: 'pmid:123' }), []);
});

test('a publication ranks under the leaf or area of its main topic', () => {
  assert.equal(publicationCategory(work(1, { primary_topic: topic('T10036', 17), topics: [topic('T10036', 17)] })), 'cs.CV');
  // A topic of several leaves ranks under their area.
  assert.equal(publicationCategory(work(2, { primary_topic: topic('T99999', 17) })), 'cs');
  assert.equal(publicationCategory({ primaryCategory: 'hep-th' }), 'hep-th');
  assert.equal(publicationCategory({ primaryCategory: 'Research Paper' }), '');
  assert.equal(publicationCategory({}), '');
});

test('the newest publications with an id the Worker can look up are kept, with the names of every work', () => {
  const papers: Array<Partial<Paper>> = [
    { id: 'semantic-scholar:abc', doi: '10.1000/s2' },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `openalex:W${index + 1}` })),
  ];
  const { seeds, keys } = feedSeedsFrom(papers);
  assert.equal(seeds.length, PUBLICATION_SEEDS_MAX);
  assert.deepEqual(seeds.map(seed => seed.id), Array.from({ length: 10 }, (_, index) => `openalex:W${index + 1}`));
  // The first paper cannot rank (no id the Worker knows) but is still left out of the feed.
  assert.ok(keys.includes('doi:10.1000/s2'));
  assert.ok(keys.includes('openalex:W12'));
  // Repeated works are kept once, and the names stop at their cap.
  assert.equal(feedSeedsFrom([{ id: 'openalex:W1' }, { id: 'openalex:W1' }]).seeds.length, 1);
  const lots = Array.from({ length: 400 }, (_, index) => ({ id: `openalex:W${index}` }));
  assert.equal(feedSeedsFrom(lots).keys.length, OWN_WORK_KEYS_MAX);
});

test('publications rank fewer as the reader shows the app more, and none once their examples fill the room', () => {
  assert.equal(publicationSeedAllowance(0), 10);
  assert.equal(publicationSeedAllowance(6), 8);
  assert.equal(publicationSeedAllowance(12), 5);
  assert.equal(publicationSeedAllowance(24), 0);
  assert.equal(publicationSeedAllowance(100), 0);
});

test('kept publications are read again when missing, a month old or dated in the future', () => {
  const now = Date.UTC(2026, 10, 27);
  assert.equal(feedSeedsStale(null, now), true);
  assert.equal(feedSeedsStale(now - 1000, now), false);
  assert.equal(feedSeedsStale(now - PUBLICATION_SEEDS_STALE_MS - 1, now), true);
  assert.equal(feedSeedsStale(now + 3_600_000, now), true);
});

test('the same publications and names need no write', () => {
  const kept = { seeds: [{ id: 'openalex:W1', category: 'cs.CV' }], keys: ['openalex:W1'] };
  assert.equal(sameFeedSeeds(kept, { seeds: [{ id: 'openalex:W1', category: 'cs.CV' }], keys: ['openalex:W1'] }), true);
  assert.equal(sameFeedSeeds(kept, { seeds: [{ id: 'openalex:W1', category: 'cs.LG' }], keys: ['openalex:W1'] }), false);
  assert.equal(sameFeedSeeds(kept, { seeds: kept.seeds, keys: [] }), false);
});

test('a publication ranks only by an id the Worker looks up, and works OpenAlex lacks are still left out', () => {
  assert.equal(workerCanLookUp('openalex:W1'), true);
  assert.equal(workerCanLookUp('pmid:123'), true);
  assert.equal(workerCanLookUp('2401.12345v2'), true);
  assert.equal(workerCanLookUp('doi:10.1000/abc'), true);
  // Past the relay's 240-character path, or a provider id the Worker does not read.
  assert.equal(workerCanLookUp(`doi:10.1000/${'a'.repeat(240)}`), false);
  assert.equal(workerCanLookUp('semantic-scholar:abc'), false);
  const { seeds, keys } = feedSeedsFrom([{ id: `doi:10.1000/${'a'.repeat(240)}` }, { id: 'openalex:W2' }], ['doi:10.1000/orcid-only', 'arxiv:2401.00001']);
  assert.deepEqual(seeds.map(seed => seed.id), ['openalex:W2']);
  assert.ok(keys.includes('doi:10.1000/orcid-only') && keys.includes('arxiv:2401.00001'));
  assert.equal(isOwnWork({ id: 'x', doi: '10.1000/ORCID-ONLY' }, new Set(keys)), true);
});
