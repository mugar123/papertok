import test from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEntity } from '../utils/following.ts';
import type { FeedPlan } from './feed-corpus-requests.ts';
import { FOLLOWED_PER_PAGE, followedCorpusRequest } from './feed-corpus-requests.ts';
import { fetchFollowedEntityCandidates } from './feed-follows.ts';
import { hasSeenPaper, readFeedSeenFilter } from '../utils/seen-paper-filter.ts';

const WORKER = 'https://papertok-report-api.example';
const author: FollowEntity = { type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez' };
const topic: FollowEntity = { type: 'topic', canonicalId: 'cs.LG', displayName: 'Machine Learning' };
// The follows rank by the plan's examples (followedCorpusRequest).
const plan: FeedPlan = { groups: [], unassignedPositiveIds: ['2610.00001'], positiveIds: ['2610.00001'], dormantCategories: [], interestProgress: {}, coldAdded: [] };

// Synthetic, in the shape /store/papers answers a follows' page (worker/paper-feed.ts).
function corpus(papers: unknown[]) {
  const asked: Array<Record<string, unknown>> = [];
  const options = {
    apiBase: WORKER,
    fetchWorker: async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ papers, skipsSeen: true }), { status: 200 });
    },
  };
  return { asked, options };
}

test('followed authors and category topics come back as followed papers, each with the follows it matched, and the request says what the reader has seen', async () => {
  const { asked, options } = corpus([
    { id: 'by-author-0', title: 'By the author', _followedEntityMatches: [{ type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez' }] },
    { id: 'in-topic-0', title: 'In the topic', _fetchedFor: ['cs.LG'] },
  ]);
  const seen = new Set(['seen-before']);
  const papers = await fetchFollowedEntityCandidates(followedCorpusRequest(
    plan,
    [author, topic],
    follow => (follow.canonicalId === 'cs.LG' ? ['cs.LG'] : []),
    { page: 2, order: 'recent', negativeIds: ['2610.00002'], excludedIds: ['2610.00003'], seen },
  ), options);
  assert.equal(asked.length, 1, 'one request for every follow');
  const { seen: filter, ...request } = asked[0];
  assert.deepEqual(request, {
    // The category topic is asked for as its category; the Worker reads no follow for it.
    categories: ['cs.LG'],
    follows: [{ type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez', metadata: {} }],
    positiveIds: ['2610.00001'], negativeIds: ['2610.00002'], excludedIds: ['2610.00003'],
    page: 2, pageSize: FOLLOWED_PER_PAGE, order: 'recent', skipsSeen: true,
  });
  // What the reader has seen goes too, so a Worker that skips seen papers sends the follows' next unseen ones.
  assert.equal(hasSeenPaper(readFeedSeenFilter(filter), 'seen-before'), true);
  assert.deepEqual(papers.map(paper => [paper.id, paper._type, (paper._followedEntityMatches as Array<{ canonicalId: string }>).map(match => match.canonicalId)]), [
    ['by-author-0', 'followed', ['A5023888391']],
    ['in-topic-0', 'followed', ['cs.LG']],
  ]);
});
