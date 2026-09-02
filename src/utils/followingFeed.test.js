import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFollowReasonLabel,
  getFollowingFeedRelevanceScore,
  orderFollowingFeedPapers,
} from './followingFeed.js';

const NOW = Date.parse('2026-07-28T12:00:00Z');

function followedPaper(id, followId, overrides = {}) {
  return {
    id,
    title: `Paper ${id}`,
    published: '2026-07-20',
    citationCount: 2,
    _followedEntityMatches: [{
      type: 'institution',
      canonicalId: followId,
      displayName: followId,
    }],
    ...overrides,
  };
}

test('names the followed entity behind a paper', () => {
  assert.equal(
    buildFollowReasonLabel([{ type: 'author', displayName: 'Haim Goldberg' }]),
    'Porque sigues a Haim Goldberg',
  );
  assert.equal(
    buildFollowReasonLabel([{ type: 'topic', displayName: 'Cosmología' }]),
    'Porque sigues Cosmología',
  );
  assert.equal(
    buildFollowReasonLabel([{ type: 'institution', displayName: 'Leiden University' }]),
    'Porque sigues Leiden University',
  );
  assert.equal(
    buildFollowReasonLabel([{ type: 'project', displayName: 'NuBSM' }]),
    'Porque sigues el proyecto NuBSM',
  );
});

test('localizes followed taxonomy topics without changing stored follow data', () => {
  const galacticAstrophysics = {
    type: 'topic',
    canonicalId: 'astro-ph.GA',
    displayName: 'Astrofísica Galáctica',
  };

  assert.equal(
    buildFollowReasonLabel([galacticAstrophysics], 'en'),
    'Because you follow Astrophysics of Galaxies',
  );
  assert.equal(
    buildFollowReasonLabel([galacticAstrophysics], 'es'),
    'Porque sigues Astrofísica Galáctica',
  );
  assert.equal(galacticAstrophysics.displayName, 'Astrofísica Galáctica');
});

test('localizes followed institutions without changing their official identity', () => {
  const university = {
    type: 'institution',
    canonicalId: '02f40zc51',
    displayName: 'Universidad de Salamanca',
    metadata: {
      localizedNames: {
        es: 'Universidad de Salamanca',
        en: 'University of Salamanca',
      },
    },
  };

  assert.equal(
    buildFollowReasonLabel([university], 'en'),
    'Because you follow University of Salamanca',
  );
  assert.equal(
    buildFollowReasonLabel([university], 'es'),
    'Porque sigues Universidad de Salamanca',
  );
  assert.equal(university.displayName, 'Universidad de Salamanca');
});

test('joins two reasons and collapses three or more', () => {
  assert.equal(
    buildFollowReasonLabel([
      { type: 'author', displayName: 'Ada Lovelace' },
      { type: 'topic', displayName: 'Computación' },
    ]),
    'Porque sigues a Ada Lovelace y Computación',
  );
  assert.equal(
    buildFollowReasonLabel([
      { type: 'author', displayName: 'A' },
      { type: 'topic', displayName: 'B' },
      { type: 'project', displayName: 'C' },
    ]),
    'Coincide con varios de tus seguimientos',
  );
  assert.equal(buildFollowReasonLabel([]), '');
  assert.equal(buildFollowReasonLabel([{ type: 'author' }]), '');
});

test('uses seen state as a novelty signal without hiding a much stronger paper', () => {
  const items = [
    followedPaper('seen-relevant', 'MIT', { doi: '10.1/a', published: '2026-07-27', citationCount: 20 }),
    followedPaper('unseen-stale', 'MIT', { doi: '10.1/b', published: '2026-02-01', citationCount: 0 }),
  ];
  const seen = new Set(['doi:10.1/a']);

  const ordered = orderFollowingFeedPapers(items, seen, { now: NOW }).map(paper => paper.id);
  assert.deepEqual(ordered, ['seen-relevant', 'unseen-stale']);
});

test('rewards papers that match several followed entities', () => {
  const singleMatch = followedPaper('single', 'MIT');
  const multipleMatches = {
    ...followedPaper('multiple', 'MIT'),
    _followedEntityMatches: [
      ...singleMatch._followedEntityMatches,
      { type: 'topic', canonicalId: 'T1', displayName: 'Quantum Physics' },
    ],
  };

  assert.ok(
    getFollowingFeedRelevanceScore(multipleMatches, new Set(), NOW)
      > getFollowingFeedRelevanceScore(singleMatch, new Set(), NOW),
  );
});

test('mixes similarly relevant follows instead of preserving five-paper source blocks', () => {
  const items = [
    ...Array.from({ length: 5 }, (_, index) => followedPaper(`mit-${index}`, 'MIT')),
    ...Array.from({ length: 5 }, (_, index) => followedPaper(`leiden-${index}`, 'Leiden')),
  ];
  const ordered = orderFollowingFeedPapers(items, new Set(), { now: NOW });
  const followIds = ordered.map(paper => paper._followedEntityMatches[0].canonicalId);
  let longestRun = 1;
  let currentRun = 1;
  for (let index = 1; index < followIds.length; index += 1) {
    currentRun = followIds[index] === followIds[index - 1] ? currentRun + 1 : 1;
    longestRun = Math.max(longestRun, currentRun);
  }

  assert.ok(followIds.slice(0, 4).includes('MIT'));
  assert.ok(followIds.slice(0, 4).includes('Leiden'));
  assert.ok(longestRun <= 2);
});

test('breaks otherwise equal relevance with citations and tolerates empty input', () => {
  const items = [
    followedPaper('low', 'MIT', { doi: '10.2/a', citationCount: 1 }),
    followedPaper('high', 'Leiden', { doi: '10.2/b', citationCount: 40 }),
  ];
  const ordered = orderFollowingFeedPapers(items, new Set(), { now: NOW }).map(paper => paper.id);
  assert.deepEqual(ordered, ['high', 'low']);
  assert.deepEqual(orderFollowingFeedPapers(undefined, undefined), []);
});

import { readFile } from 'node:fs/promises';
import { mergeOrderedPapers } from './followingFeed.js';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * A silent refresh landing while the Following feed is on screen used to
 * re-rank the whole list under the reader. The cards already showing keep
 * their places, under their fresh copies; what the refresh dropped goes,
 * what it brought is appended in its own order.
 */
test('a refresh keeps the cards on screen where they are and appends what is new', () => {
  const previous = [
    { id: 'a', title: 'A', citationCount: 1 },
    { id: 'b', title: 'B', citationCount: 1 },
    { id: 'c', title: 'C', citationCount: 1 },
  ];
  const fresh = [
    { id: 'd', title: 'D', citationCount: 9 },
    { id: 'c', title: 'C', citationCount: 5 },
    { id: 'a', title: 'A', citationCount: 4 },
    { id: 'e', title: 'E', citationCount: 2 },
  ];
  const merged = mergeOrderedPapers(previous, fresh);
  assert.deepEqual(merged.map(paper => paper.id), ['a', 'c', 'd', 'e'], 'a and c stay in order, b is gone, d and e follow');
  assert.equal(merged[0].citationCount, 4, 'the copy on screen is the fresh one');
  assert.equal(mergeOrderedPapers([], fresh), fresh, 'nothing on screen: the fresh ranking as is');
  assert.deepEqual(mergeOrderedPapers(previous, []), [], 'the refresh emptied the feed');
});

test('SOURCE: the Following page ranks on its first render and merges refreshes', async () => {
  const code = await readSource('../components/Following/FollowingFeedPage.jsx');
  assert.match(code, /useState\(\(\) => orderFollowingFeedPapers\(items, seenIds\)\)/,
    'an empty initial state painted the empty state for a frame before the cards');
  assert.match(code, /setOrderedPapers\(current => mergeOrderedPapers\(current, orderFollowingFeedPapers\(items, seenIds\)\)\)/);
});

test('SOURCE: the follow-reason pill arrives as the first step of the card, not on a fade of its own', async () => {
  const jsx = await readSource('../components/Feed/PaperCard.jsx');
  const css = await readSource('../components/Feed/PaperCard.css');
  assert.match(jsx, /<div className="pc-follow-reason">/);
  assert.doesNotMatch(jsx, /<motion\.div\s+className="pc-follow-reason"/);
  assert.match(css, /\.pc-follow-reason \{ --arrive: 0; \}/);
  assert.match(css, /@keyframes pcArrive \{/);
  assert.match(css, /@keyframes cardSlideUp \{\s*0% \{ transform: translateY\(10px\); \}/, 'the sheet only travels; the pieces carry the fade');
});
