import assert from 'node:assert/strict';
import test from 'node:test';

import { createFollowEntity, followsEntity } from './following.ts';
import { followReasonLabels, followsAnyAuthor } from './follow-reasons.ts';

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

// A card's author reaches the follows with every id it carries (ENG-123): Europe PMC
// supplies the ORCID iD, enrichment adds an OpenAlex id that may not be the followed one.
test('a card labels an author followed by ORCID iD although its OpenAlex id differs', () => {
  const follows = [createFollowEntity({ type: 'author', id: 'A1', displayName: 'Josiah Carberry', externalIds: { orcid: '0000-0002-1825-0097' } })!];
  const isFollowing = (entity: Parameters<typeof followsEntity>[1]) => followsEntity(follows, entity);
  const labelsFor = (authors: Parameters<typeof followsAnyAuthor>[0]) => followReasonLabels([], followsAnyAuthor(authors, isFollowing), isFollowing).map(item => item.label);

  assert.deepEqual(labelsFor([{ name: 'Josiah Carberry', id: 'https://openalex.org/A2', orcid: 'https://orcid.org/0000-0002-1825-0097' }]), ['Followed author']);
  // The same name with no id in common is another author.
  assert.deepEqual(labelsFor([{ name: 'Josiah Carberry', id: 'https://openalex.org/A2' }]), []);
  assert.deepEqual(labelsFor([{ name: 'Josiah Carberry', id: 'https://openalex.org/A2', orcid: '0000-0001-5109-3700' }]), []);
  // An author known by name alone is still recognised by name.
  assert.deepEqual(labelsFor(['Josiah Carberry']), ['Followed author']);
});
