import assert from 'node:assert/strict';
import test from 'node:test';

import { followReasonLabels } from './follow-reasons.ts';

const match = (type: 'author' | 'topic' | 'institution' | 'project' | 'journal') => ({ type, canonicalId: `${type}-1`, displayName: type });

const all = () => true;

test('one label per matched follow type, in a fixed order', () => {
  const labels = followReasonLabels([match('journal'), match('topic'), match('topic'), match('author')], false, all);
  assert.deepEqual(labels.map(item => item.label), ['Followed author', 'Followed topic', 'Followed journal']);
});

test('covers institution and project, and a followed author found on the card counts once', () => {
  const labels = followReasonLabels([match('project'), match('institution'), match('author')], true, all);
  assert.deepEqual(labels.map(item => item.type), ['author', 'institution', 'project']);
});

test('no matches, legacy string matches and unknown types give no label', () => {
  assert.deepEqual(followReasonLabels(undefined, false, all), []);
  assert.deepEqual(followReasonLabels(['project-3'], false, all), []);
  assert.deepEqual(followReasonLabels([{ type: 'mystery', canonicalId: 'x', displayName: 'x' } as never], false, all), []);
  assert.deepEqual(followReasonLabels([], true, all).map(item => item.label), ['Followed author']);
});

test('a match the reader no longer follows gives no label', () => {
  const stillFollowed = (m: { canonicalId: string }) => m.canonicalId === 'topic-1';
  const labels = followReasonLabels([match('author'), match('topic'), match('journal')], false, stillFollowed);
  assert.deepEqual(labels.map(item => item.type), ['topic']);
});
