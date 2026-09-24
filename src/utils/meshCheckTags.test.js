import test from 'node:test';
import assert from 'node:assert/strict';
import { isMeshCheckTag, orderMeshDescriptors } from './meshCheckTags.js';

test('the NLM check tags are recognised, in any case, and a subject is not', () => {
  for (const tag of ['Humans', 'Female', 'Male', 'Animals', 'Aged, 80 and over', 'Infant, Newborn', 'Middle Aged', 'Mice', 'Rats', 'Pregnancy', 'History, 20th Century', 'humans']) {
    assert.equal(isMeshCheckTag(tag), true, tag);
  }
  for (const subject of ['Heart Failure', 'Troponin I', 'Humanities', 'Female Urogenital Diseases', '']) {
    assert.equal(isMeshCheckTag(subject), false, subject);
  }
});

test('descriptors come major topics first, check tags dropped, order kept inside each group', () => {
  assert.deepEqual(orderMeshDescriptors([
    { name: 'Humans', major: false },
    { name: 'Troponin I', major: false },
    { name: 'Heart Failure', major: true },
    { name: 'Female', major: false },
    { name: 'Biomarkers', major: true },
    { name: 'Heart Failure', major: false },
  ]), ['Heart Failure', 'Biomarkers', 'Troponin I']);
});
