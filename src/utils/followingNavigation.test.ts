import test from 'node:test';
import assert from 'node:assert/strict';
import { getFollowedEntityPath } from './followingNavigation.ts';

test('builds a navigable institution route from a saved follow', () => {
  assert.equal(
    getFollowedEntityPath({
      type: 'institution',
      canonicalId: 'I123',
      displayName: 'Universidad de Salamanca',
    }),
    '/explorer/institution/I123?name=Universidad+de+Salamanca',
  );
});

test('uses the display name for a legacy author follow', () => {
  assert.equal(
    getFollowedEntityPath({
      type: 'author',
      canonicalId: 'legacy:ada lovelace',
      displayName: 'Ada Lovelace',
    }),
    '/explorer/author/Ada%20Lovelace?name=Ada+Lovelace',
  );
});

test('keeps project navigation metadata and rejects unsupported entities', () => {
  assert.equal(
    getFollowedEntityPath({
      type: 'project',
      canonicalId: '10101',
      displayName: 'Project Atlas',
      metadata: { funder: 'ERC' },
    }),
    '/explorer/project/10101?name=Project+Atlas&funder=ERC',
  );
  assert.equal(getFollowedEntityPath({ type: 'source' as never }), '/settings/following');
});
