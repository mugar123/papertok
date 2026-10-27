import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreReadLater } from './read-later-rollback.ts';

type Entry = { paperId: string; paper: { title: string }; readLater?: boolean; note?: string; updatedAt?: string | number | null };

// Read later shows the newest edit first, as the Lists page sorts it.
const readLaterOrder = (library: Record<string, Entry>) => Object.values(library)
  .filter((entry) => entry.readLater)
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  .map((entry) => entry.paperId);

test('a refused Read later removal puts the paper back in its place, not at the top', () => {
  const before: Record<string, Entry> = {
    p1: { paperId: 'p1', paper: { title: 'One' }, readLater: true, updatedAt: '2026-10-22T09:00:00.000Z' },
    p2: { paperId: 'p2', paper: { title: 'Two' }, readLater: true, updatedAt: '2026-10-20T09:00:00.000Z' },
  };
  // What the optimistic change left: the mark off, stamped now, with a fresh copy.
  const changed = { ...before, p2: { ...before.p2, paper: { title: 'Two, refreshed' }, readLater: false, updatedAt: '2026-10-26T09:00:00.000Z', note: 'typed meanwhile' } };
  const restored = restoreReadLater(changed, 'p2', before.p2);
  assert.deepEqual(readLaterOrder(restored), ['p1', 'p2']);
  assert.deepEqual(restored.p2.paper, { title: 'Two' });
  assert.equal(restored.p2.note, 'typed meanwhile', 'a field edited meanwhile is kept');
});

test('a refused first save to Read later leaves no mark and no edit time', () => {
  const changed: Record<string, Entry> = {
    p3: { paperId: 'p3', paper: { title: 'Three' }, readLater: true, updatedAt: '2026-10-26T09:00:00.000Z' },
  };
  const restored = restoreReadLater(changed, 'p3', undefined);
  assert.equal(restored.p3.readLater, false);
  assert.equal(restored.p3.updatedAt, undefined);
});
