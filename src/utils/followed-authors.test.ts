import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleFollowedAuthor } from './followed-authors.ts';

const transforms = {
  union: (name: unknown) => ({ op: 'union', name } as import('firebase/firestore').FieldValue & { op: string; name: string }),
  remove: (name: unknown) => ({ op: 'remove', name } as import('firebase/firestore').FieldValue & { op: string; name: string }),
};

test('following adds locally and sends a union, never the whole array', () => {
  const result = toggleFollowedAuthor(['Ada'], 'Grace', transforms);
  assert.deepEqual(result.next, ['Ada', 'Grace']);
  assert.deepEqual(result.patch, { followedAuthors: { op: 'union', name: 'Grace' } });
});

test('unfollowing removes locally and sends a remove', () => {
  const result = toggleFollowedAuthor(['Ada', 'Grace'], 'Ada', transforms);
  assert.deepEqual(result.next, ['Grace']);
  assert.deepEqual(result.patch, { followedAuthors: { op: 'remove', name: 'Ada' } });
});
