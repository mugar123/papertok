import test from 'node:test';
import assert from 'node:assert/strict';
import { aboutFollowTargets } from './about-follow-targets.ts';
import { createFollowEntity, followsEntity, planFollowToggle } from '../../utils/following.ts';

test('lists each institution with a verified id once, whichever id it carries', () => {
  const institutions = aboutFollowTargets({
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

// Journal follows were retired: a paper's journal is no longer offered.
test('offers no journal, and nothing when the paper has no institution', () => {
  assert.deepEqual(aboutFollowTargets({ venueId: 'S49861241', sourceName: 'The Lancet', journal: 'The Lancet' }), []);
  assert.deepEqual(aboutFollowTargets({}), []);
  assert.deepEqual(aboutFollowTargets(null), []);
});

test('following an offered institution toggles through the follow model by id', () => {
  const [oxford, cern] = aboutFollowTargets({ institutions: [
    { id: 'I114027177', displayName: 'University of Oxford' },
    { id: 'I67311998', displayName: 'CERN' },
  ] });
  const followed = [createFollowEntity(oxford)!];
  assert.equal(followsEntity(followed, oxford), true);
  assert.equal(followsEntity(followed, cern), false);

  const afterFollow = planFollowToggle(followed, createFollowEntity(cern)!);
  assert.equal(afterFollow.existing, undefined);
  assert.equal(followsEntity(afterFollow.next, cern), true);

  const afterUnfollow = planFollowToggle(afterFollow.next, createFollowEntity(cern)!);
  assert.equal(followsEntity(afterUnfollow.next, cern), false);
  assert.equal(followsEntity(afterUnfollow.next, oxford), true);
});
