import assert from 'node:assert/strict';
import test from 'node:test';

import { feedReason } from './feed-reason.ts';
import { followedOnCard } from './follow-reasons.ts';

const match = (type: 'author' | 'topic' | 'institution' | 'project' | 'journal', displayName = `The ${type}`) => (
  { type, canonicalId: `${type}-1`, displayName }
);

const all = () => true;
function followLabel(...args: Parameters<typeof followedOnCard>) {
  return feedReason({}, followedOnCard(...args), 'following', 'Research Paper')?.text ?? null;
}

test('a card with several follows names one, authors before topics before journals', () => {
  assert.equal(
    followLabel([match('journal'), match('topic'), match('author', 'Emmy Noether')], null, all),
    'Because you follow Emmy Noether',
  );
  assert.equal(followLabel([match('journal'), match('topic')], null, all), 'Because you follow The topic');
  assert.equal(followLabel([match('journal'), match('project'), match('institution')], null, all), 'Because you follow The institution');
  assert.equal(followLabel([match('journal'), match('project')], null, all), 'Because you follow The project');
  assert.equal(followLabel([match('journal')], null, all), 'Because you follow The journal');
});

test('a followed author found on the card is named before a request match of another type', () => {
  assert.equal(followLabel([match('topic')], 'Yann LeCun', all), 'You follow Yann LeCun');
  assert.equal(followLabel(undefined, 'Yann LeCun', all), 'You follow Yann LeCun');
});

test('a request author is named when the card also recognizes a different author', () => {
  assert.equal(followLabel([match('author', 'Emmy Noether')], 'Yann LeCun', all), 'Because you follow Emmy Noether');
});

test('no matches, legacy string matches and unknown types name no follow', () => {
  assert.equal(followLabel(undefined, null, all), null);
  assert.equal(followLabel(['project-3'], null, all), null);
  assert.equal(followLabel([{ type: 'mystery', canonicalId: 'x', displayName: 'x' } as never], null, all), null);
});

test('a match the reader no longer follows is not named', () => {
  const stillFollowed = (m: { canonicalId: string }) => m.canonicalId === 'topic-1';
  assert.equal(followLabel([match('author'), match('topic'), match('journal')], null, stillFollowed), 'Because you follow The topic');
  assert.equal(followLabel([match('author')], null, () => false), null);
});

test('a match that carries its id for a name has no name to show', () => {
  assert.equal(followLabel([match('topic', 'topic-1')], null, all), 'Because you follow this topic');
});

test('the reader\'s stored follow names the match before the name the corpus echoed', () => {
  assert.equal(followLabel([match('topic', 'Old name')], null, all, () => 'New name'), 'Because you follow New name');
  assert.equal(followLabel([match('topic', 'Old name')], null, all, () => undefined), 'Because you follow Old name');
});
