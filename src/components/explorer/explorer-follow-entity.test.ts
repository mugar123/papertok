import test from 'node:test';
import assert from 'node:assert/strict';
import { explorerAuthorIdentityUnverified, explorerFollowEntity } from './explorer-follow-entity.ts';
import { createFollowEntity } from '../../utils/following.ts';

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

// ENG-123 (D2, D5): the Explorer's source page offers Follow for a journal,
// by its OpenAlex id, with its ISSN-L for display. A repository's firehose,
// a conference and the working-paper series OpenAlex types as journals do
// not get one. Source records shaped as OpenAlex returns them; the ids are
// real (AER from `/sources/issn:0002-8282` on 2026-10-25).
test('a journal can be followed from its source page; a repository or a working-paper series cannot', () => {
  const sourcePage = (entity: { id: string; type: string; issn_l?: string | null }, name: string) => explorerFollowEntity({
    type: 'source', routeId: entity.id.split('/').pop()!, entity, authorIdentityUnverified: false, officialName: name, displayName: name,
  });
  const journal = sourcePage({ id: 'https://openalex.org/S23254222', type: 'journal', issn_l: '0002-8282' }, 'American Economic Review');
  assert.deepEqual(createFollowEntity(journal!), {
    type: 'journal',
    canonicalId: 'S23254222',
    displayName: 'American Economic Review',
    source: 'openalex',
    externalIds: { issnl: '0002-8282' },
    metadata: {},
  });
  assert.equal(sourcePage({ id: 'https://openalex.org/S4306400194', type: 'repository' }, 'arXiv (Cornell University)'), null);
  assert.equal(sourcePage({ id: 'https://openalex.org/S4210171147', type: 'journal' }, 'IMF Working Paper'), null);
});

test('no entity yet is not an unverified author, and has no Follow', () => {
  assert.equal(explorerAuthorIdentityUnverified({ type: 'author', routeId: 'Wei Zhang', entity: null }), false);
  assert.equal(explorerFollowEntity({
    type: 'author', routeId: 'Wei Zhang', entity: null, authorIdentityUnverified: false, officialName: '', displayName: '',
  }), null);
});
