import test from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEntity } from '../utils/following.ts';
import type { CategoryExposure, PositiveExample } from '../utils/interaction-profile.ts';
import type { InterestMemoryInput } from '../utils/interest-memory.ts';
import { feedPlanFor, followedCorpusRequest, mainCorpusRequest } from './feed-corpus-requests.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';
import { getFollowedTopicCategoryIds } from '../services/topic-retrieval-service.ts';
import { scorePaperForRecommendation } from '../utils/recommendation-engine.ts';

const memory = (input: Partial<InterestMemoryInput>): InterestMemoryInput => ({
  selected: [], deselected: [], added: [], examples: [], exposure: {}, affinities: {}, ...input,
});

const examples = (category: string, count: number) =>
  Array.from({ length: count }, (_, index): PositiveExample => ({ id: `${category}-${index}`, category }));

const shown = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).map(([category, count]): [string, CategoryExposure] => [category, { shown: count, engaged: 0 }]));

// The bodies the feed's requests send to /store/papers.
async function bodiesOf(...requests: Parameters<typeof fetchCorpusPage>[0][]) {
  const bodies: Array<{ categories: string[]; positiveIds: string[]; negativeIds?: string[]; excludedIds?: string[]; groups?: Array<{ categories: string[] }> }> = [];
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
    // A like of physics, an area the reader never chose, ranks as it did
    // before groups (ENG-137, R18); it asks for no physics category.
    examples: [...examples('econ.EM', 2), ...examples('quant-ph', 1)],
  }));

  const [main, follows] = await bodiesOf(
    mainCorpusRequest(plan, shared),
    followedCorpusRequest(plan, [physics], follow => getFollowedTopicCategoryIds([follow]), shared).request,
  );

  assert.deepEqual(main.categories.filter(category => physicsCategories.includes(category)), []);
  assert.deepEqual(main.groups!.flatMap(group => group.categories).filter(category => physicsCategories.includes(category)), []);
  assert.deepEqual(follows.categories, physicsCategories);
  assert.deepEqual(main.positiveIds, ['econ.EM-0', 'econ.EM-1', 'quant-ph-0']);
  assert.deepEqual(follows.positiveIds, ['econ.EM-0', 'econ.EM-1', 'quant-ph-0']);
});

test("a list's later pages ask by the groups its first page planned", async () => {
  const atReset = memory({ selected: ['quant-ph', 'econ.EM'], added: ['econ.EM'], examples: examples('quant-ph', 10) });
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

test('the scoring of a list reads the progress, removed and cold-added subareas its first page planned', () => {
  const atReset = memory({ selected: ['quant-ph', 'econ.EM'], deselected: ['hep-th'], added: ['econ.EM'], examples: examples('quant-ph', 10) });
  const plan = feedPlanFor(null, 0, atReset);

  assert.equal(plan.interestProgress['quant-ph'], 1);
  assert.equal(plan.interestProgress['econ.EM'], 0);
  assert.deepEqual(plan.dormantCategories, ['hep-th']);
  assert.deepEqual(plan.coldAdded, ['econ.EM']);

  // The cards the reader sees afterwards move the memory, not the list's plan.
  const later = feedPlanFor(plan, 1, { ...atReset, exposure: shown({ 'econ.EM': 60 }) });
  assert.equal(later.interestProgress, plan.interestProgress);
  assert.equal(later.dormantCategories, plan.dormantCategories);
  assert.equal(later.coldAdded, plan.coldAdded);
});

/*
 * ENG-137, ruling R18: only what the reader deselected sleeps. A card the
 * scoring reads with a list's plan is dormant only when every piece of area
 * evidence it carries was removed; an area the reader never picked scores as
 * it does on main.
 */
const NOW = Date.parse('2026-07-05T12:00:00Z');
// What the feed's scoring reads of a plan.
const scoringMemoryOf = ({ interestProgress, coldAdded, dormantCategories }: ReturnType<typeof feedPlanFor>) => ({ interestProgress, coldAdded, dormantCategories });
const learned = { 'cs.CR': 40, 'hep-th': 40, 'gr-qc': 40, physics: 40, 'quant-ph': 40 };
const cardIn = (primaryCategory: string) => ({
  id: `followed-${primaryCategory}`, primaryCategory, published: '2026-07-05T00:00:00Z', _semanticScore: 0.5, _type: 'followed' as const,
});
const scoreWithPlan = (primaryCategory: string, input: InterestMemoryInput) => scorePaperForRecommendation(cardIn(primaryCategory), {
  now: NOW, userPreferences: input.selected, categoryAffinities: learned, ...scoringMemoryOf(feedPlanFor(null, 0, input)),
});

test('a reader who never edited their interests is scored as on main, in every area', () => {
  const reader = memory({ selected: ['cs.LG', 'cs.AI'] });
  for (const category of ['cs.CR', 'hep-th', 'physics', 'cs.LG']) {
    const main = scorePaperForRecommendation(cardIn(category), { now: NOW, userPreferences: reader.selected, categoryAffinities: learned });
    assert.deepEqual(scoreWithPlan(category, reader), main, category);
  }
  const security = scoreWithPlan('cs.CR', reader);
  assert.deepEqual([security.corpusSimilarity, security.affinity], [50, 40]);
});

test('what the reader deselected sleeps, and the rest of its area does not', () => {
  const leftPhysics = memory({ selected: ['cs.LG'], deselected: ['quant-ph', 'hep-th'] });
  assert.equal(scoreWithPlan('hep-th', leftPhysics).corpusSimilarity, 0);
  assert.equal(scoreWithPlan('physics', leftPhysics).corpusSimilarity, 0, 'the area key, with no Physics subarea selected');
  assert.deepEqual([scoreWithPlan('gr-qc', leftPhysics).corpusSimilarity, scoreWithPlan('gr-qc', leftPhysics).affinity], [50, 40], 'a subarea never picked');

  const keptQuantum = memory({ selected: ['cs.LG', 'quant-ph'], deselected: ['hep-th'] });
  assert.equal(scoreWithPlan('hep-th', keptQuantum).corpusSimilarity, 0);
  assert.equal(scoreWithPlan('physics', keptQuantum).corpusSimilarity, 50, 'the area key, with a Physics subarea selected');
});

test('a full plan leaves room for every rejection and exclusion a request carries', async () => {
  const id = (prefix: string, index: number) => `10.1000/${prefix}.${index}.`.padEnd(40, 'x');
  const selected = ['cs.LG', 'cs.AI', 'cs.CV', 'cs.RO', 'quant-ph', 'hep-th', 'math.PR', 'stat.ML', 'econ.EM', 'econ.GN'];
  const plan = feedPlanFor(null, 0, memory({
    selected,
    added: ['econ.EM', 'econ.GN'],
    examples: selected.flatMap(category => Array.from({ length: 3 }, (_, index) => ({ id: id(category, index), category }))).slice(0, 24),
  }));
  const negativeIds = Array.from({ length: 24 }, (_, index) => id('negative', index));
  const excludedIds = Array.from({ length: 130 }, (_, index) => id('excluded', index));
  const [body] = await bodiesOf(mainCorpusRequest(plan, { page: 0, order: 'recent', negativeIds, excludedIds }));
  assert.equal(body.negativeIds?.length, 24);
  assert.equal(body.excludedIds?.length, 130);
});
