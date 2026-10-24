import test from 'node:test';
import assert from 'node:assert/strict';
import { explorerAuthorIdentityUnverified, explorerFollowEntity } from './explorerFollowEntity.ts';

/** The page's Follow for an author route, computed the way EntityExplorer does. */
function authorFollow(routeId: string, entity: { id?: string; verified?: boolean; orcid?: string | null }, name: string) {
  const authorIdentityUnverified = explorerAuthorIdentityUnverified({ type: 'author', routeId, entity });
  return {
    authorIdentityUnverified,
    follow: explorerFollowEntity({ type: 'author', routeId, entity, authorIdentityUnverified, officialName: name, displayName: name }),
  };
}

// "Wei Zhang" is thousands of OpenAlex authors: the name search's first hit is
// not the person the link meant (audit 2026-09-23).
test('an author found only by name gets no Follow', () => {
  const byName = authorFollow('Wei Zhang', { id: 'https://openalex.org/A5023888391' }, 'Wei Zhang');
  assert.equal(byName.authorIdentityUnverified, true);
  assert.equal(byName.follow, null);

  const unconfirmedByPaper = authorFollow('Li WN', { id: 'https://openalex.org/A5100000001', verified: false }, 'Po-Wn Li');
  assert.equal(unconfirmedByPaper.follow, null);

  const orcidStub = authorFollow('0000-0002-1825-0097', { id: 'stub-0000-0002-1825-0097' }, 'Josiah Carberry');
  assert.equal(orcidStub.follow, null);
});

test('an author the route or the source paper identifies can be followed', () => {
  const byId = authorFollow('A5023888391', { id: 'https://openalex.org/A5023888391' }, 'Wei Zhang').follow;
  assert.deepEqual([byId?.type, byId?.id, byId?.displayName], ['author', 'https://openalex.org/A5023888391', 'Wei Zhang']);
  const confirmed = authorFollow('Wei Zhang', { id: 'https://openalex.org/A5023888391', verified: true }, 'Wei Zhang');
  assert.equal(confirmed.authorIdentityUnverified, false);
  assert.equal(confirmed.follow?.id, 'https://openalex.org/A5023888391');
});

test('no entity yet is not an unverified author, and has no Follow', () => {
  assert.equal(explorerAuthorIdentityUnverified({ type: 'author', routeId: 'Wei Zhang', entity: null }), false);
  assert.equal(explorerFollowEntity({
    type: 'author', routeId: 'Wei Zhang', entity: null, authorIdentityUnverified: false, officialName: '', displayName: '',
  }), null);
});
