import test from 'node:test';
import assert from 'node:assert/strict';
import { newestFirst } from './passage-order.ts';

const at = (seconds: number) => ({ seconds, nanoseconds: 0 });

test('stored highlights come newest first', () => {
  const list = [{ id: 'old', createdAt: at(100) }, { id: 'new', createdAt: at(300) }, { id: 'mid', createdAt: at(200) }];
  assert.deepEqual(newestFirst(list).map(item => item.id), ['new', 'mid', 'old']);
});

test('highlights saved in this session, not yet stamped by the server, go on top, the last saved first', () => {
  const list = [{ id: 'stored', createdAt: at(300) }, { id: 'first-save' }, { id: 'second-save' }];
  assert.deepEqual(newestFirst(list).map(item => item.id), ['second-save', 'first-save', 'stored']);
});
