import test from 'node:test';
import assert from 'node:assert/strict';
import { appendNewRows } from './threadRows.js';

test('paging appends only the rows the sheet does not already show', () => {
  const previous = [{ id: 'a' }, { id: 'b' }];
  const fresh = [{ id: 'b', text: 'again' }, { id: 'c' }];
  const merged = appendNewRows(previous, fresh);
  assert.deepEqual(merged.map(row => row.id), ['a', 'b', 'c']);
  assert.equal(merged[1], previous[1], 'the row already on screen keeps its object');
  assert.equal(appendNewRows(previous, [{ id: 'a' }]), previous, 'nothing new returns the same array');
});
