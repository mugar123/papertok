import test from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEntity } from '../utils/following.ts';
import type { CategoryExposure, PositiveExample } from '../utils/interaction-profile.ts';
import type { InterestMemoryInput } from '../utils/interest-memory.ts';
import { feedPlanFor, followedCorpusRequest, mainCorpusRequest } from './feed-corpus-requests.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';
import { getFollowedTopicCategoryIds } from '../services/topic-retrieval-service.ts';

const memory = (input: Partial<InterestMemoryInput>): InterestMemoryInput => ({
  selected: [], deselected: [], examples: [], exposure: {}, affinities: {}, ...input,
});

const examples = (category: string, count: number) =>
  Array.from({ length: count }, (_, index): PositiveExample => ({ id: `${category}-${index}`, category }));

const shown = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).map(([category, count]): [string, CategoryExposure] => [category, { shown: count, engaged: 0 }]));

// The bodies the feed's requests send to /store/papers.
async function bodiesOf(...requests: Parameters<typeof fetchCorpusPage>[0][]) {
  const bodies: Array<{ categories: string[]; positiveIds: string[]; groups?: Array<{ categories: string[] }> }> = [];
  for (const request of requests) {
    await fetchCorpusPage(request, {
      apiBase: 'https://papertok-report-api.example',
      fetchWorker: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ papers: [] }), { status: 200 });
      },
    });
  }
  return bodies;
}

const shared = { page: 0, order: 'recent', negativeIds: [], excludedIds: [] };

test('a followed topic fills only the follows request, ranked by the examples of the chosen areas', async () => {
  const physics = { type: 'topic', canonicalId: 'physics', displayName: 'Physics', followKey: 'topic:physics', metadata: {} } as FollowEntity;
  const physicsCategories = getFollowedTopicCategoryIds([physics]);
  assert.ok(physicsCategories.includes('quant-ph'), 'the follow stands for physics categories');
  const plan = feedPlanFor(null, 0, memory({
    selected: ['econ.EM', 'econ.GN', 'econ.TH'],
    // A like of physics, an area the reader never chose: its memory sleeps.
    examples: [...examples('econ.EM', 2), ...examples('quant-ph', 1)],
  }));

  const [main, follows] = await bodiesOf(
    mainCorpusRequest(plan, shared),
    followedCorpusRequest(plan, [physics], follow => getFollowedTopicCategoryIds([follow]), shared).request,
  );

  assert.deepEqual(main.categories.filter(category => physicsCategories.includes(category)), []);
  assert.deepEqual(main.groups!.flatMap(group => group.categories).filter(category => physicsCategories.includes(category)), []);
  assert.deepEqual(follows.categories, physicsCategories);
  assert.deepEqual(main.positiveIds, ['econ.EM-0', 'econ.EM-1']);
  assert.deepEqual(follows.positiveIds, ['econ.EM-0', 'econ.EM-1']);
});

test("a list's later pages ask by the groups its first page planned", async () => {
  const atReset = memory({ selected: ['quant-ph', 'econ.EM'], examples: examples('quant-ph', 10) });
  // Economics showed the cards that make it a learned area before page 1.
  const atPageOne = { ...atReset, exposure: shown({ 'econ.EM': 60 }) };
  const replanned = feedPlanFor(null, 0, atPageOne).groups;

  const plan = feedPlanFor(null, 0, atReset);
  assert.notDeepEqual(plan.groups, replanned, 'the seen cards change the plan');
  const [first, second] = await bodiesOf(
    mainCorpusRequest(plan, shared),
    mainCorpusRequest(feedPlanFor(plan, 1, atPageOne), { ...shared, page: 1 }),
  );
  assert.deepEqual(second.groups, first.groups);
  assert.deepEqual(second.groups, plan.groups);

  // A new list plans again, and so does a page with no plan of this session (a restored snapshot).
  assert.deepEqual(feedPlanFor(plan, 0, atPageOne).groups, replanned);
  assert.deepEqual(feedPlanFor(null, 2, atPageOne).groups, replanned);
});

test('the scoring of a list reads the progress and active subareas its first page planned', () => {
  const atReset = memory({ selected: ['quant-ph', 'econ.EM'], deselected: ['hep-th'], examples: examples('quant-ph', 10) });
  const plan = feedPlanFor(null, 0, atReset);

  assert.equal(plan.interestProgress['quant-ph'], 1);
  assert.equal(plan.interestProgress['econ.EM'], 0);
  assert.ok(plan.activeCategories.includes('quant-ph') && !plan.activeCategories.includes('hep-th'));

  // The cards the reader sees afterwards move the memory, not the list's plan.
  const later = feedPlanFor(plan, 1, { ...atReset, exposure: shown({ 'econ.EM': 60 }) });
  assert.equal(later.interestProgress, plan.interestProgress);
  assert.equal(later.activeCategories, plan.activeCategories);
});
