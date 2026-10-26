import test from 'node:test';
import assert from 'node:assert/strict';
import { entityLane, followLane } from './follow-lanes.ts';

test('a follow is served from the lane its entity names, and a followed category from the category itself', () => {
  assert.equal(followLane({ type: 'author', canonicalId: 'https://openalex.org/A5023888391' }), 'author:A5023888391');
  assert.equal(followLane({ type: 'institution', canonicalId: 'I1321305853' }), 'institution:I1321305853');
  assert.equal(followLane({ type: 'topic', canonicalId: 'T10604' }), 'topic:T10604');
  assert.equal(followLane({ type: 'topic', canonicalId: 'C41008148' }), 'concept:C41008148');
  assert.equal(followLane({ type: 'topic', canonicalId: 'cs.LG' }), '', 'asked for as the category');
  assert.equal(followLane({ type: 'topic', canonicalId: 'query:abc', displayName: 'Graph Neural Networks', metadata: { query: 'graph neural networks' } }), 'query:graph neural networks');
  assert.equal(followLane({ type: 'author', canonicalId: 'yann-lecun', displayName: 'Yann LeCun' }), 'author-name:yann lecun');
  assert.equal(followLane({ type: 'project', canonicalId: '101034344', metadata: { funder: 'EC' } }), 'project:EC|101034344');
  assert.equal(followLane({ type: 'author', canonicalId: 'T10604' }), '', 'a topic id is no author, and there is no name to search');
  assert.equal(followLane({ type: 'institution', canonicalId: 'mit', displayName: 'MIT' }), '', 'an institution is served by its OpenAlex id only');
});

test("a paper's OpenAlex authors, institutions, topics and concepts name the lanes it is filed under", () => {
  assert.equal(entityLane('https://openalex.org/A5023888391'), 'author:A5023888391');
  assert.equal(entityLane('i1321305853'), 'institution:I1321305853');
  assert.equal(entityLane('https://openalex.org/W2107743791'), '', 'a work is no entity');
  assert.equal(entityLane(null), '');
});
