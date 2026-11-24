import test from 'node:test';
import assert from 'node:assert/strict';
import { getFollowedEntityPath } from './following-navigation.ts';

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

test('the Explorer receives the English name for its loading heading', () => {
  const path = getFollowedEntityPath({
    type: 'topic', canonicalId: 'T123', displayName: 'Física', metadata: { labelEn: 'Physics' },
  });
  assert.equal(path, '/explorer/topic/T123?name=Physics');
});

test('a keyword route keeps the text its search uses', () => {
  const path = getFollowedEntityPath({
    type: 'topic', canonicalId: 'query-1234abcd', displayName: 'ondas', metadata: { labelEn: 'Waves' },
  });
  assert.equal(path, '/explorer/topic/query-1234abcd?name=ondas');
});

test('a taxonomy route opens under the canonical English label', () => {
  const path = getFollowedEntityPath({
    type: 'topic', canonicalId: 'physics', displayName: 'Física', metadata: { labelEn: 'Physical sciences' },
  });
  assert.equal(path, '/explorer/topic/physics?name=Physics');
});
