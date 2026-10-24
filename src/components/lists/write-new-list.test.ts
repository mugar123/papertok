import test from 'node:test';
import assert from 'node:assert/strict';
import { writeNewList } from './write-new-list.ts';

const newList = () => ({ id: 'list_1', name: 'Reading group', paperIds: [] as string[] });

test('a failed create reaches the dialog instead of ending in the console', async () => {
  const published: string[] = [];
  await assert.rejects(writeNewList(newList(), {
    isPublic: true,
    write: () => Promise.reject(new Error('permission-denied')),
    publish: () => { published.push('list_1'); return Promise.resolve({ shareId: 'share-1' }); },
    onPublishFailed: () => {},
  }), /permission-denied/);
  assert.deepEqual(published, [], 'a list that was never written is never published');
});

test('a public list that fails to publish is created, stays private, and the owner is told', async () => {
  const list = newList();
  const failures: unknown[] = [];
  const publishError = new Error('worker unreachable');
  await writeNewList(list, {
    isPublic: true,
    write: () => Promise.resolve(),
    publish: () => Promise.reject(publishError),
    onPublishFailed: (error) => { failures.push(error); },
  });
  assert.deepEqual(failures, [publishError]);
  assert.deepEqual(list, { id: 'list_1', name: 'Reading group', paperIds: [] });
});

test('a public list that publishes carries its share id', async () => {
  const list: ReturnType<typeof newList> & { publicShareId?: string; publicSyncedAt?: Date } = newList();
  const written: string[] = [];
  await writeNewList(list, {
    isPublic: true,
    write: (entry) => { written.push(entry.id); return Promise.resolve(); },
    publish: () => Promise.resolve({ shareId: 'share-1' }),
    onPublishFailed: () => { assert.fail('the publish succeeded'); },
  });
  assert.deepEqual(written, ['list_1']);
  assert.equal(list.publicShareId, 'share-1');
  assert.ok(list.publicSyncedAt instanceof Date);
});

test('a private list is written and never published', async () => {
  const calls: string[] = [];
  await writeNewList(newList(), {
    isPublic: false,
    write: () => { calls.push('write'); return Promise.resolve(); },
    publish: () => { calls.push('publish'); return Promise.resolve({ shareId: 'share-1' }); },
    onPublishFailed: () => { calls.push('failed'); },
  });
  assert.deepEqual(calls, ['write']);
});
