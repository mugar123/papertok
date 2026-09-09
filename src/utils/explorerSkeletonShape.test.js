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
  // An author's ORCID card is reserved only when the route knows there is one
  // (an ORCID id in the route). Three of four authors opened in the 2026-09-05
  // audit had no record: a reserved block that never comes is the list rising
  // 113px 400ms after the page has already landed, while an unreserved one that
  // does come grows the hero from the bottom under the settle's clip.
  assert.equal(explorerSkeletonShape('author').aside, 'none');
  assert.equal(explorerSkeletonShape('author', { hasOrcid: true }).aside, 'orcid');
  // The Wikipedia block is reserved by NOBODY, and that is the point.
  // Reserved space and an entrance animation are two answers to the same
  // question. Between 2026-09-06 and 2026-09-08 the block was reserved here
  // and held open on its grey rows until Wikipedia answered, because
  // unreserved it used to appear at full height in one frame (measured on
  // T11090 from cold at 1280×900: the body went 109 → 234px the moment the
  // entity came). It unfolds on arrival now instead (EntityExplorer.jsx), so
  // reserving it too would give the reader the same complaint from the other
  // side: the skeleton holds 146px, the live hero lands without the block
  // because the lookup is still out, the settle shrinks the box by that much,
  // and the unfold grows it back — down, then up.
  assert.equal(explorerSkeletonShape('institution').aside, 'none');
  assert.equal(explorerSkeletonShape('topic').aside, 'none');
  assert.equal(explorerSkeletonShape('concept').aside, 'none');
  // Measured at 390px: a project hero landed 276px taller than its skeleton,
  // 122 of it the summary box OpenAIRE returns for nearly every grant.
  assert.equal(explorerSkeletonShape('project').aside, 'summary');
});

test('the stats grid reserves the cells that usually land', () => {
  // The OpenAlex counts always come; a project's cells are each conditional
  // and two is the usual number — four reserved shrank the grid by a row.
  for (const type of ['author', 'institution', 'concept', 'topic']) {
    assert.equal(explorerSkeletonShape(type).stats, 4);
  }
  assert.equal(explorerSkeletonShape('project').stats, 2);
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

test('the skeleton knows which pages carry the recent-impact cell', () => {
  // `RecentImpactStat` mounts for authors and institutions only
  // (EntityExplorer.jsx), and its cell is the one with a two-line detail
  // under the label. Measured 2026-09-09 on a cold author: the cell grew
  // 64.5 → 77.5px when the score landed and the ORCID card under the header
  // dropped 10.3px in one frame. The skeleton reserves that detail line on
  // exactly the pages where the cell lands, and nowhere else.
  assert.equal(explorerSkeletonShape('author').impact, true);
  assert.equal(explorerSkeletonShape('institution').impact, true);
  for (const type of ['concept', 'topic', 'project', 'source']) {
    assert.equal(explorerSkeletonShape(type).impact, false);
  }
});
