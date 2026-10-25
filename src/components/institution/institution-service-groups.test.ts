import assert from 'node:assert/strict';
import test from 'node:test';
import { groupInstitutionServices, type InstitutionService } from './institution-service-groups.ts';

const source = (id: string, name: string, extra: Partial<InstitutionService> = {}): InstitutionService => ({
  id, name, publisher: 'Springer Nature', monogram: 'N', color: null,
  url: `https://library.example/${id}`, collection: null, ownPlatform: true, ...extra,
});

test('journals share their platform group even when the platform sample arrives later', () => {
  const chemistry = source('journal-1755-4330', 'Nature Chemistry', { platformId: 'nature' });
  const nature = source('nature', 'Nature');
  const materials = source('journal-1476-1122', 'Nature Materials', { platformId: 'nature' });
  const groups = groupInstitutionServices([chemistry, nature, materials]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'nature');
  assert.equal(groups[0].name, 'Nature');
  assert.equal(groups[0].representative, nature);
  assert.deepEqual(groups[0].services, [chemistry, nature, materials]);
});

test('a journal-only group names its publisher without inventing an entitled platform sample', () => {
  const journal = source('journal-0736-5829', 'Adapted Physical Activity Quarterly', { platformId: 'humankinetics', publisher: 'Human Kinetics' });
  const [group] = groupInstitutionServices([journal]);
  assert.equal(group.name, 'Human Kinetics');
  assert.deepEqual(group.services, [journal]);
});

test('shared publisher labels do not merge separate platforms or standalone publications', () => {
  const sources = [source('nature', 'Nature'), source('springerlink', 'SpringerLink'), source('guardian', 'The Guardian')];
  assert.deepEqual(groupInstitutionServices(sources).map(group => group.id), ['nature', 'springerlink', 'guardian']);
});

test('grouping keeps each journal access route, URL and collection instead of promoting access to the publisher', () => {
  const direct = source('journal-direct', 'Direct title', { platformId: 'nature' });
  const aggregate = source('journal-aggregate', 'Archived title', { platformId: 'nature', collection: 'ProQuest Central', ownPlatform: false, url: 'https://library.example/proquest' });
  const [group] = groupInstitutionServices([direct, aggregate]);
  assert.equal(group.services[0].ownPlatform, true);
  assert.equal(group.services[1].ownPlatform, false);
  assert.equal(group.services[1].collection, 'ProQuest Central');
  assert.equal(group.services[1].url, 'https://library.example/proquest');
});

test('empty results stay empty and grouping never carries another reading forward', () => {
  assert.deepEqual(groupInstitutionServices([]), []);
  const first = groupInstitutionServices([source('nature', 'Nature')]);
  assert.deepEqual(groupInstitutionServices([source('sage', 'SAGE')]).map(group => group.id), ['sage']);
  assert.deepEqual(first.map(group => group.id), ['nature']);
});
