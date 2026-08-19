import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_PROFILE_TABS,
  VISITOR_PROFILE_TABS,
  resolveProfileView,
} from './profileAccess.js';

test('a visitor gets the public tab and nothing else', () => {
  for (const view of [
    resolveProfileView({ viewerUid: 'someone-else', profileUid: 'owner' }),
    resolveProfileView({ viewerUid: null, profileUid: 'owner' }),
    resolveProfileView({ viewerUid: undefined, profileUid: 'owner' }),
    resolveProfileView({ viewerUid: '', profileUid: 'owner' }),
    resolveProfileView({}),
  ]) {
    assert.equal(view.isOwner, false);
    assert.deepEqual([...view.tabs], ['lists']);
    assert.ok(!view.tabs.includes('saved'), 'saved papers are owner-only');
    assert.ok(!view.tabs.includes('liked'), 'likes are owner-only');
  }
});

test('matching uids make the owner, on the public route too', () => {
  const view = resolveProfileView({ viewerUid: 'owner', profileUid: 'owner' });
  assert.equal(view.isOwner, true);
  assert.deepEqual([...view.tabs], ['lists', 'saved', 'liked']);
});

test('two empty uids do not accidentally match', () => {
  // A signed-out viewer on a profile document that somehow lacks an uid must
  // never fall into `'' === ''`.
  assert.equal(resolveProfileView({ viewerUid: '', profileUid: '' }).isOwner, false);
});

test('selfMode asserts ownership without a profile document', () => {
  // /profile renders behind ProtectedRoute; the document may not exist yet.
  const view = resolveProfileView({ viewerUid: 'owner', profileUid: undefined, selfMode: true });
  assert.equal(view.isOwner, true);
  // And it must be the boolean true, not any truthy routing accident.
  assert.equal(resolveProfileView({ selfMode: 'yes', profileUid: 'p' }).isOwner, false);
});

test('the tab constants stay frozen', () => {
  assert.throws(() => { OWNER_PROFILE_TABS.push('secret'); });
  assert.throws(() => { VISITOR_PROFILE_TABS.push('saved'); });
});
