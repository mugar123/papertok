import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { Paper } from '../models/Paper.ts';
import { applyKnownPublicationTypes } from '../services/feedPublicationService.ts';
import { isFeedPublication } from '../services/feedPublicationRules.ts';
import { placeNotableCards } from '../utils/feedEnrichment.ts';

const source = readFileSync(new URL('./FeedContext.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function feedSnapshotKey(');
const end = source.indexOf('// ── Demo mode storage helpers', start);
assert.ok(start >= 0 && end > start);
const helpers = stripTypeScriptTypes(source.slice(start, end));
type Publications = Pick<typeof import('../services/feedPublicationService.ts'), 'applyKnownPublicationTypes'>;
function snapshots(publications: Publications = { applyKnownPublicationTypes }) {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => stored.set(key, value) };
  const helpersFor = new Function(
    'localStorage', 'FEED_SNAPSHOT_TTL_MS', 'FEED_SNAPSHOT_MAX_PAPERS', 'applyKnownPublicationTypes', 'isFeedPublication', 'placeNotableCards',
    `${helpers}; return { feedSnapshotKey, readFeedSnapshot, writeFeedSnapshot };`,
  );
  return { stored, ...helpersFor(storage, 15 * 60 * 1000, 30, publications.applyKnownPublicationTypes, isFeedPublication, placeNotableCards) };
}

test('old unchecked snapshots are refreshed, while current snapshots preserve scientific reviews and account isolation', () => {
  const { stored, feedSnapshotKey, readFeedSnapshot, writeFeedSnapshot } = snapshots();
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    savedAt: Date.now(), papers: [{ id: 'W568341909', publicationType: 'article' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null);
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    publicationPolicy: 1, savedAt: Date.now(), papers: [{ id: 'openalex:W1503277431', publicationType: 'article' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null);
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    publicationPolicy: 2, savedAt: Date.now(), papers: [{ id: 'W2020715063', abstract: '' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null, 'pre-admission recovery must run for old snapshots');
  const papers = [{ id: 'scientific-review', publicationType: 'review' }];
  writeFeedSnapshot('test-user', 'math.AG', { papers, page: 2, hasMore: true });
  assert.deepEqual(readFeedSnapshot('test-user', 'math.AG').papers, papers);
  assert.equal(readFeedSnapshot('test-user', 'math.AG').page, 2);
  assert.equal(readFeedSnapshot('different-user', 'math.AG'), null);
});

test('a book Crossref confirmed after its card was saved is left out when the snapshot is restored', async t => {
  // A separate instance of the publication service: its own Crossref cache.
  const publications = await import(new URL('../services/feedPublicationService.ts?snapshot-restore', import.meta.url).href) as typeof import('../services/feedPublicationService.ts');
  const { readFeedSnapshot, writeFeedSnapshot } = snapshots(publications);
  const card = (id: string, doi: string) => ({ id, doi, title: `Synthetic paper ${id}`, authors: [], abstract: '', publicationType: 'article', sources: { primary: 'openalex', enrichedBy: [] } });
  const visible = card('W3029239115', '10.1016/j.indag.2021.09.002');
  const book = card('W568341909', '10.1007/978-3-540-76956-9');
  // Saved while the reader was on these two cards, so the book stayed on screen.
  writeFeedSnapshot('test-user', 'math.AG', { papers: [visible, book], page: 1, hasMore: true });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI === book.doi ? 'book' : 'journal-article' })) } });
  });
  await publications.classifyFeedPublications([visible, book]);
  assert.deepEqual(readFeedSnapshot('test-user', 'math.AG').papers.map((paper: { id: string }) => paper.id), [visible.id]);
});

// One feed card in 15 is notable (placeNotableCards), counted from the first.
test('a book known when a snapshot is restored leaves no shorter gap before the notable card after it', () => {
  const card = (id: string, publicationType = 'article'): Paper => ({ id, title: `Synthetic paper ${id}`, abstract: '', authors: [], publicationType, sources: { primary: 'openalex', enrichedBy: [] } });
  // Crossref has since called the sixth card a book.
  const { readFeedSnapshot, writeFeedSnapshot } = snapshots({ applyKnownPublicationTypes: papers => papers.map(paper => (paper.id === 'card-5' ? card(paper.id, 'book') : paper)) });
  const others = Array.from({ length: 29 }, (_, index) => card(`card-${index}`));
  writeFeedSnapshot('test-user', 'cs.AI', { papers: placeNotableCards(others, [{ ...card('notable-0'), _notable: true }]), page: 2, hasMore: true });
  const restored: Paper[] = readFeedSnapshot('test-user', 'cs.AI').papers;
  assert.deepEqual(restored.flatMap((paper, index) => (paper._notable ? [[index, paper.id]] : [])), [[14, 'notable-0']]);
  assert.deepEqual(restored.filter(paper => !paper._notable).map(paper => paper.id), others.filter(paper => paper.id !== 'card-5').map(paper => paper.id));
});

test('late answers to a restored snapshot keep its save time, while a newly loaded page starts its fifteen minutes', t => {
  const { readFeedSnapshot, writeFeedSnapshot } = snapshots();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const card = { id: 'W2020715063', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
  writeFeedSnapshot('test-user', 'cs.AI', { papers: [card], page: 1, hasMore: true });
  now += 10 * 60 * 1000;
  // A cold open restores it, and a late abstract updates the restored cards.
  const restored = readFeedSnapshot('test-user', 'cs.AI');
  writeFeedSnapshot('test-user', 'cs.AI', { ...restored, papers: [{ ...card, abstract: 'Recovered source text.' }] });
  now += 6 * 60 * 1000;
  assert.equal(readFeedSnapshot('test-user', 'cs.AI'), null, 'the snapshot expires fifteen minutes after its page loaded');
  writeFeedSnapshot('test-user', 'cs.AI', { papers: [card], page: 1, hasMore: true });
  now += 10 * 60 * 1000;
  assert.deepEqual(readFeedSnapshot('test-user', 'cs.AI').papers.map((paper: { id: string }) => paper.id), [card.id]);
});

// FeedContext cannot be mounted under Node; feedUsableBatch.test.ts runs the
// restore itself. This pins that both restoring effects go through it, and
// that a cold mount does not read the snapshot again once it is shown.
test('SOURCE: both snapshot effects restore through one owner, read once on a cold mount', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.equal(code.match(/restoreFeedSnapshot\(snapshot, feedMode, signature\);/g)?.length, 2);
  assert.equal(code.match(/setPapers\(snapshot\.papers\)/g)?.length, 1, 'only the owner shows a stored page');
  assert.match(code, /if \(isColdMount && restoredFeedKeyRef\.current === `\$\{activeUserId\.current\}:\$\{signature\}`\) return;\s*feedCache\.current = \{\};/);
});
