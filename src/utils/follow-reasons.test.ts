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
  assert.equal(followLabel([match('topic', 'Old name')], null, all, () => match('topic', 'New name')), 'Because you follow New name');
  assert.equal(followLabel([match('topic', 'Old name')], null, all, () => undefined), 'Because you follow Old name');
});

test('a For You card names a legacy topic follow in English', () => {
  const stored = { type: 'topic' as const, canonicalId: 'physics', displayName: 'Física' };
  const echoed = { ...stored, displayName: 'Physics' };
  const followed = followedOnCard([echoed], null, all, () => stored);
  assert.equal(feedReason({}, followed, 'feed', 'Quantum Physics')?.text, 'Because you follow Physics');
});

test('a named corpus match resolves by topic id when there is no stored follow', () => {
  const topic = { type: 'topic' as const, canonicalId: 'physics', displayName: 'Física' };
  assert.equal(followLabel([topic], null, all), 'Because you follow Physics');
  assert.equal(followLabel([{ ...topic, displayName: 'physics' }], null, all), 'Because you follow this topic');
});

test('a stored English label takes precedence over the taxonomy and an unnamed match', () => {
  const echoed = { type: 'topic' as const, canonicalId: 'physics', displayName: 'physics' };
  const stored = { ...echoed, displayName: 'Física', metadata: { labelEn: 'Physical sciences' } };
  assert.equal(followLabel([echoed], null, all, () => stored), 'Because you follow Physical sciences');
});

test('keywords keep the text the reader typed, including capitalization', () => {
  for (const text of ['ondas de luz', 'pHySiCs']) {
    const keyword = { type: 'topic' as const, canonicalId: 'query-1234abcd', displayName: text, metadata: { query: text } };
    assert.equal(followLabel([keyword], null, all), `Because you follow ${text}`);
  }
});

test('a legacy topic outside the taxonomy keeps its name even if the id looks like words', () => {
  const topic = { type: 'topic' as const, canonicalId: 'old-subject-17', displayName: 'Ondas de materia' };
  assert.equal(followLabel([topic], null, all), 'Because you follow Ondas de materia');
});

test('an institution uses its English name and authors, journals and projects keep their names', () => {
  const institution = { ...match('institution', 'Universidad de Salamanca'), metadata: { localizedNames: { en: 'University of Salamanca' } } };
  assert.equal(followLabel([institution], null, all), 'Because you follow University of Salamanca');
  for (const entity of [match('author', 'Óscar Díaz'), match('journal', 'El Profesional de la Información'), match('project', 'Luz y Materia')]) {
    assert.equal(followLabel([entity], null, all), `Because you follow ${entity.displayName}`);
  }
});
