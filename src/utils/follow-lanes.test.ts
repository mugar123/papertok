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

// ENG-123: a journal is followed by its OpenAlex source id, and served from
// that source's lane. Its name is no lane: a search by name would be another
// journal's papers as often as its own.
test("a followed journal is served from its source's lane, and only by its source id", () => {
  assert.equal(followLane({ type: 'journal', canonicalId: 'S23254222', displayName: 'American Economic Review' }), 'source:S23254222');
  assert.equal(followLane({ type: 'journal', canonicalId: 'https://openalex.org/S23254222' }), 'source:S23254222');
  assert.equal(followLane({ type: 'journal', canonicalId: '0002-8282', displayName: 'American Economic Review' }), '', 'an ISSN is no source id');
  assert.equal(followLane({ type: 'journal', canonicalId: 'A5023888391', displayName: 'Wei Zhang' }), '', 'an author id is no journal');
  assert.equal(followLane({ type: 'author', canonicalId: 'S23254222' }), '', 'a source id is no author');
});

test("a paper's OpenAlex authors, institutions, topics, concepts and journal name the lanes it is filed under", () => {
  assert.equal(entityLane('https://openalex.org/S23254222'), 'source:S23254222');
  assert.equal(entityLane('https://openalex.org/A5023888391'), 'author:A5023888391');
  assert.equal(entityLane('i1321305853'), 'institution:I1321305853');
  assert.equal(entityLane('https://openalex.org/W2107743791'), '', 'a work is no entity');
  assert.equal(entityLane(null), '');
});
