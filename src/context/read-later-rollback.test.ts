import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreReadLater } from './read-later-rollback.ts';

type Entry = { paperId: string; paper: { title: string; primaryTopic?: string }; readLater?: boolean; note?: string; updatedAt?: string | number | null };

// Read later shows the newest edit first, as the Lists page sorts it.
const readLaterOrder = (library: Record<string, Entry>) => Object.values(library)
  .filter((entry) => entry.readLater)
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  .map((entry) => entry.paperId);

const before: Record<string, Entry> = {
  p1: { paperId: 'p1', paper: { title: 'One' }, readLater: true, updatedAt: '2026-10-22T09:00:00.000Z' },
  p2: { paperId: 'p2', paper: { title: 'Two' }, readLater: true, updatedAt: '2026-10-20T09:00:00.000Z' },
};
// What a Read later removal of p2 put on screen: the mark off, stamped now, with a fresh copy.
const stamped = { paper: { title: 'Two, refreshed' }, updatedAt: '2026-10-26T09:00:00.000Z' };
const removed = { ...before, p2: { ...before.p2, ...stamped, readLater: false } };

test('a refused Read later removal puts the paper back in its place, not at the top', () => {
  const changed: Record<string, Entry> = { ...removed, p2: { ...removed.p2, note: 'typed meanwhile' } };
  const restored = restoreReadLater(changed, 'p2', before.p2, stamped);
  assert.deepEqual(readLaterOrder(restored), ['p1', 'p2']);
  assert.deepEqual(restored.p2.paper, { title: 'Two' });
  assert.equal(restored.p2.note, 'typed meanwhile', 'a field edited meanwhile is kept');
});

test('a refused first save to Read later leaves no mark and no edit time', () => {
  const copy = { title: 'Three' };
  const changed: Record<string, Entry> = {
    p3: { paperId: 'p3', paper: copy, readLater: true, updatedAt: '2026-10-26T09:00:00.000Z' },
  };
  const restored = restoreReadLater(changed, 'p3', undefined, { paper: copy, updatedAt: '2026-10-26T09:00:00.000Z' });
  assert.equal(restored.p3.readLater, false);
  assert.equal(restored.p3.updatedAt, undefined);
});

test('a refused Read later removal keeps the topic a late enrichment added to the paper copy meanwhile', () => {
  // keepLateTopics completes the stored copy with a new object.
  const enriched: Record<string, Entry> = { ...removed, p2: { ...removed.p2, paper: { ...stamped.paper, primaryTopic: 'Galaxy formation' } } };
  const restored = restoreReadLater(enriched, 'p2', before.p2, stamped);
  assert.equal(restored.p2.paper.primaryTopic, 'Galaxy formation');
  assert.equal(restored.p2.readLater, true);
  assert.equal(restored.p2.updatedAt, before.p2.updatedAt, 'the edit time this change stamped still goes back');
});

test('a refused Read later removal keeps the later edit time a note saved meanwhile stamped', () => {
  // saveReadingMetadata stamps its own edit time and copy.
  const noted: Record<string, Entry> = { ...removed, p2: { ...removed.p2, paper: { title: 'Two' }, note: 'read the appendix', updatedAt: '2026-10-27T09:00:00.000Z' } };
  const restored = restoreReadLater(noted, 'p2', before.p2, stamped);
  assert.deepEqual(readLaterOrder(restored), ['p2', 'p1'], 'ordered by the note\'s edit, the latest');
  assert.equal(restored.p2.updatedAt, '2026-10-27T09:00:00.000Z');
  assert.equal(restored.p2.note, 'read the appendix');
});
