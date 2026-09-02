import test from 'node:test';
import assert from 'node:assert/strict';
import { lateSourceCandidates } from './feedLateCandidates.js';

const paper = (id) => ({ id, title: id, sources: { primary: 'test', enrichedBy: [] } });

test('keeps only the papers the first paint did not already show', () => {
  const shown = [paper('a'), paper('b')];
  const settled = [
    { status: 'fulfilled', value: [paper('a'), paper('b')] },
    { status: 'fulfilled', value: [paper('c'), paper('a')] },
    { status: 'timed_out' },
    { status: 'rejected', reason: new Error('down') },
  ];
  assert.deepEqual(lateSourceCandidates(shown, settled).map(p => p.id), ['c']);
});

test('is empty when nothing new arrived', () => {
  assert.deepEqual(lateSourceCandidates([paper('a')], [{ status: 'fulfilled', value: [paper('a')] }]), []);
  assert.deepEqual(lateSourceCandidates([], []), []);
});
