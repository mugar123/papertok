import test from 'node:test';
import assert from 'node:assert/strict';
import { aboutFollowTargets } from './about-follow-targets.ts';
import { createFollowEntity, followsEntity, planFollowToggle } from '../../utils/following.ts';

const lancet = { venueId: 'S49861241', sourceName: 'The Lancet', journal: 'The Lancet' };

test('offers the journal OpenAlex identifies, by its id and name', () => {
  const { journal } = aboutFollowTargets({ ...lancet });
  assert.deepEqual(createFollowEntity(journal!), {
    type: 'journal',
    canonicalId: 'S49861241',
    displayName: 'The Lancet',
    source: 'openalex',
    externalIds: {},
    metadata: {},
  });
});

test('offers no journal without a verified source id, a name, or for a working-paper series', () => {
  assert.equal(aboutFollowTargets({ journal: 'The Lancet' }).journal, null);
  assert.equal(aboutFollowTargets({ journal: 'The Lancet', venueId: 'not-an-id' }).journal, null);
  assert.equal(aboutFollowTargets({ venueId: 'S49861241' }).journal, null);
  assert.equal(aboutFollowTargets({ venueId: 'S2809516038', sourceName: 'National Bureau of Economic Research' }).journal, null);
});

test('lists each institution with a verified id once, whichever id it carries', () => {
  const { institutions } = aboutFollowTargets({
    institutions: [
      { id: 'https://openalex.org/I114027177', ror: 'https://ror.org/01ggx4157', displayName: 'University of Oxford' },
      { id: 'I114027177', displayName: 'University of Oxford (again)' },
      { id: '', ror: 'https://ror.org/02f40zc51', display_name: 'CERN' },
      { id: 'Oxford University', displayName: 'Named only' },
      { displayName: 'No id at all' },
      { id: 'I1', displayName: '  ' },
    ],
  });
  assert.deepEqual(institutions.map(entity => [entity.id, entity.displayName, entity.externalIds]), [
    ['I114027177', 'University of Oxford', { ror: '01ggx4157' }],
    ['02f40zc51', 'CERN', { ror: '02f40zc51' }],
  ]);
});

test('offers nothing when the paper has neither a journal nor an institution', () => {
  assert.deepEqual(aboutFollowTargets({}), { journal: null, institutions: [] });
  assert.deepEqual(aboutFollowTargets(null), { journal: null, institutions: [] });
});

test('following an offered journal and institution toggles through the follow model by id', () => {
  const { journal, institutions } = aboutFollowTargets({ ...lancet, institutions: [{ id: 'I114027177', displayName: 'University of Oxford' }] });
  const followed = [createFollowEntity(institutions[0]!)!];
  assert.equal(followsEntity(followed, institutions[0]!), true);
  assert.equal(followsEntity(followed, journal!), false);

  const afterFollow = planFollowToggle(followed, createFollowEntity(journal!)!, { list: 'listed' });
  assert.equal(afterFollow.existing, undefined);
  assert.equal(followsEntity(afterFollow.next, journal!), true);
  // The same journal under another spelling of its name is the same follow.
  assert.equal(followsEntity(afterFollow.next, { ...journal!, displayName: 'Lancet' }), true);

  const afterUnfollow = planFollowToggle(afterFollow.next, createFollowEntity(journal!)!, { list: 'listed' });
  assert.equal(followsEntity(afterUnfollow.next, journal!), false);
  assert.equal(followsEntity(afterUnfollow.next, institutions[0]!), true);
});
