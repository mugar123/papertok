import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAuthorsTab, explorerSkeletonShape } from './explorerSkeletonShape.js';

test('an author page has no Authors tab', () => {
  assert.equal(hasAuthorsTab('author'), false);
  assert.equal(explorerSkeletonShape('author').tabs, 1);
});

test('a project has no Authors tab either, despite looking like an organisation', () => {
  // The assumption worth pinning: a project page is organisation-shaped, so it
  // reads as though it should index people. Its papers come from OpenAIRE,
  // which indexes participants, and the live tab strip excludes it.
  assert.equal(hasAuthorsTab('project'), false);
  assert.equal(explorerSkeletonShape('project').tabs, 1);
});

test('an institution has both tabs', () => {
  assert.equal(hasAuthorsTab('institution'), true);
  assert.equal(explorerSkeletonShape('institution').tabs, 2);
});

test('a topic has both tabs until it turns out to be a local or free-text one', () => {
  assert.equal(hasAuthorsTab('topic'), true);
  assert.equal(hasAuthorsTab('concept'), true);
  assert.equal(hasAuthorsTab('topic', { _localTopic: true }), false);
  assert.equal(hasAuthorsTab('concept', { _queryTopic: true }), false);
});

test('the entity can only ever remove the tab, never add one', () => {
  // The skeleton answers without an entity; if a later entity could turn a
  // one-tab page into a two-tab one, the skeleton would be promising too
  // little and the strip would grow under the reader.
  for (const type of ['author', 'project']) {
    assert.equal(hasAuthorsTab(type, { _localTopic: false, _queryTopic: false }), false);
  }
});

test('each type reserves the block it actually carries', () => {
  assert.equal(explorerSkeletonShape('author').aside, 'orcid');
  assert.equal(explorerSkeletonShape('institution').aside, 'wiki');
  assert.equal(explorerSkeletonShape('project').aside, 'none');
});

test('the strip under the name differs by what the page puts there', () => {
  assert.equal(explorerSkeletonShape('author').identity, 'topics');
  assert.equal(explorerSkeletonShape('institution').identity, 'credentials');
  assert.equal(explorerSkeletonShape('project').identity, 'none');
});

test('every entity the Explorer serves can be followed', () => {
  for (const type of ['author', 'institution', 'project', 'concept', 'topic']) {
    assert.equal(explorerSkeletonShape(type).follow, true);
  }
});

test('an unknown type falls back to the plainest shape and still renders', () => {
  const shape = explorerSkeletonShape('source');
  assert.equal(shape.identity, 'none');
  assert.equal(shape.aside, 'none');
  assert.ok(shape.tabs >= 1);
});
