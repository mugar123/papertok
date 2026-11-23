import assert from 'node:assert/strict';
import test from 'node:test';

import { followedOnCard } from './follow-reasons.ts';

const match = (type: 'author' | 'topic' | 'institution' | 'project' | 'journal', displayName = `The ${type}`) => (
  { type, canonicalId: `${type}-1`, displayName }
);

const all = () => true;

test('a card with several follows names one, authors before topics before journals', () => {
  assert.deepEqual(
    followedOnCard([match('journal'), match('topic'), match('author', 'Emmy Noether')], null, all),
    { type: 'author', name: 'Emmy Noether' },
  );
  assert.deepEqual(followedOnCard([match('journal'), match('topic')], null, all), { type: 'topic', name: 'The topic' });
  assert.deepEqual(followedOnCard([match('journal'), match('project'), match('institution')], null, all), { type: 'institution', name: 'The institution' });
  assert.deepEqual(followedOnCard([match('journal'), match('project')], null, all), { type: 'project', name: 'The project' });
  assert.deepEqual(followedOnCard([match('journal')], null, all), { type: 'journal', name: 'The journal' });
});

test('a followed author found on the card is named before any match', () => {
  assert.deepEqual(followedOnCard([match('topic')], 'Yann LeCun', all), { type: 'author', name: 'Yann LeCun' });
  assert.deepEqual(followedOnCard(undefined, 'Yann LeCun', all), { type: 'author', name: 'Yann LeCun' });
});

test('no matches, legacy string matches and unknown types name no follow', () => {
  assert.equal(followedOnCard(undefined, null, all), null);
  assert.equal(followedOnCard(['project-3'], null, all), null);
  assert.equal(followedOnCard([{ type: 'mystery', canonicalId: 'x', displayName: 'x' } as never], null, all), null);
});

test('a match the reader no longer follows is not named', () => {
  const stillFollowed = (m: { canonicalId: string }) => m.canonicalId === 'topic-1';
  assert.deepEqual(followedOnCard([match('author'), match('topic'), match('journal')], null, stillFollowed), { type: 'topic', name: 'The topic' });
  assert.equal(followedOnCard([match('author')], null, () => false), null);
});

test('a match that carries its id for a name has no name to show', () => {
  assert.deepEqual(followedOnCard([match('topic', 'topic-1')], null, all), { type: 'topic', name: '' });
});

test('the reader\'s stored follow names the match before the name the corpus echoed', () => {
  assert.deepEqual(followedOnCard([match('topic', 'Old name')], null, all, () => 'New name'), { type: 'topic', name: 'New name' });
  assert.deepEqual(followedOnCard([match('topic', 'Old name')], null, all, () => undefined), { type: 'topic', name: 'Old name' });
});
