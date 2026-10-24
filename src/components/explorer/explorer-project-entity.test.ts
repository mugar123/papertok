import test from 'node:test';
import assert from 'node:assert/strict';
import { followsEntity, createFollowEntity } from '../../utils/following.ts';
import type { FollowEntity } from '../../utils/following.ts';
import { explorerFollowEntity } from './explorer-follow-entity.ts';
import { projectEntityFromLookup, projectLookupFunder } from './explorer-project-entity.ts';

/** The project page's Follow, computed from the entity the way EntityExplorer does. */
function projectFollow(routeId: string, entity: ReturnType<typeof projectEntityFromLookup>) {
  return explorerFollowEntity({
    type: 'project', routeId, entity, authorIdentityUnverified: false,
    officialName: entity.display_name, displayName: entity.display_name,
  });
}

// Synthetic OpenAIRE details for an SNSF grant whose code (100010) NHMRC and UKRI also use.
const snsfDetails = {
  id: '100010', openaireId: 'snsf________::daa28096', title: 'Neural coding of time', acronym: 'NeuroTime', funder: 'SNSF',
};

test('a project keeps the route id when its details arrive, and the grant code goes to code', () => {
  const entity = projectEntityFromLookup({ routeId: 'snsf________::daa28096', name: '', funder: 'SNSF', details: snsfDetails });
  assert.equal(entity.id, 'snsf________::daa28096');
  assert.equal('code' in entity && entity.code, '100010');
  assert.equal(entity.display_name, 'NeuroTime: Neural coding of time');
  assert.equal(projectFollow('snsf________::daa28096', entity)?.id, 'snsf________::daa28096');
});

test("the project is queried with the route's funder before the entity's", () => {
  assert.equal(projectLookupFunder('SNSF'), 'SNSF');
  assert.equal(projectLookupFunder('SNSF', 'NHMRC'), 'SNSF');
  assert.equal(projectLookupFunder(null, 'NHMRC'), 'NHMRC');
  assert.equal(projectLookupFunder(null), '');
});

// One OpenAIRE outage leaves several project pages with no name. A stand-in
// name made them one follow: following A, then clicking B's heart, found A as
// the existing follow and deleted A's document.
test('following a project with no name never matches another project', () => {
  const followedA = createFollowEntity(projectFollow('ukri::A', projectEntityFromLookup({
    routeId: 'ukri::A', name: '', funder: 'UKRI', details: { ...snsfDetails, id: 'A', openaireId: 'ukri::A', funder: 'UKRI' },
  }))!) as FollowEntity;
  const namelessB = projectEntityFromLookup({ routeId: 'snsf________::B', name: '', funder: 'SNSF', details: null });
  assert.equal(namelessB.display_name, '');
  assert.equal(namelessB.openaireId, 'snsf________::B');
  const followB = projectFollow('snsf________::B', namelessB);
  assert.equal(followB, null);
  assert.equal(followsEntity([followedA], { type: 'project', id: 'snsf________::B', displayName: namelessB.display_name }), false);
});

test('a failed lookup keeps the name the link carried', () => {
  const entity = projectEntityFromLookup({ routeId: '100010', name: 'NeuroTime', funder: 'SNSF', details: null });
  assert.deepEqual(entity, { id: '100010', openaireId: undefined, display_name: 'NeuroTime', type: 'project', funder: 'SNSF' });
  assert.equal(projectFollow('100010', entity)?.displayName, 'NeuroTime');
});
