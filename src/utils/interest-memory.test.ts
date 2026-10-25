import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../data/categories.ts';
import type { CategoryExposure, PositiveExample } from './interaction-profile.ts';
import { activeCategories, interestProgress, planInterestGroups, type InterestMemoryInput } from './interest-memory.ts';

const leaves = (area: string) => Object.keys(CATEGORIES[area].subcategories);

const examples = (category: string, count: number, prefix = category) =>
  Array.from({ length: count }, (_, index): PositiveExample => ({ id: `${prefix}-${index}`, category }));

const shown = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).map(([category, count]): [string, CategoryExposure] => [category, { shown: count, engaged: 0 }]));

const memory = (input: Partial<InterestMemoryInput>): InterestMemoryInput => ({
  selected: [], deselected: [], examples: [], exposure: {}, affinities: {}, ...input,
});

const areaOf = (category: string) => Object.keys(CATEGORIES).find(area => category in CATEGORIES[area].subcategories);

const weightsByArea = (input: InterestMemoryInput) =>
  Object.fromEntries(planInterestGroups(input).groups.map(group => [areaOf(group.categories[0]), group.weight]));

test('an active area is every subarea of a selected area except the deselected ones', () => {
  const active = activeCategories(['hep-th'], ['quant-ph']);
  assert.deepEqual([...active].sort(), leaves('physics').filter(leaf => leaf !== 'quant-ph').sort());
});

test('a new area weighs twice a learned one', () => {
  const input = memory({ selected: ['quant-ph', 'econ.EM'], examples: examples('quant-ph', 10) });
  assert.deepEqual(weightsByArea(input), { physics: 1, econ: 2 });
});

test('a learned area takes its share of the examples and the rest go unused', () => {
  const plan = planInterestGroups(memory({ selected: ['quant-ph', 'econ.EM'], examples: examples('quant-ph', 10) }));
  const physics = plan.groups.find(group => group.categories.includes('quant-ph'))!;
  // 24 × 1/3: the eight newest.
  assert.deepEqual(physics.positiveIds, examples('quant-ph', 8).map(example => example.id));
});

test("an area's weight falls from 2 to 1 with its examples or the cards it showed", () => {
  const weight = (input: Partial<InterestMemoryInput>) => planInterestGroups(memory({ selected: ['econ.EM'], ...input })).groups[0].weight;
  assert.equal(weight({ examples: examples('econ.EM', 4) }), 1.5);
  assert.equal(weight({ examples: examples('econ.EM', 8) }), 1);
  assert.equal(weight({ exposure: shown({ 'econ.EM': 60 }) }), 1);
});

test('a new subarea of a learned area is a group of its own until it learns', () => {
  const learned = examples('quant-ph', 10);
  const plan = planInterestGroups(memory({ selected: ['quant-ph', 'hep-th'], examples: learned }));
  assert.deepEqual(plan.groups.map(group => ({ categories: group.categories, weight: group.weight })), [
    { categories: ['quant-ph'], weight: 1 },
    { categories: ['hep-th'], weight: 1 },
  ]);
  assert.deepEqual([...plan.groups[1].exampleCategories].sort(), [...leaves('physics')].sort());

  const joined = planInterestGroups(memory({ selected: ['quant-ph', 'hep-th'], examples: [...examples('hep-th', 3), ...learned] }));
  assert.equal(joined.groups.length, 1);
  assert.ok(joined.groups[0].categories.includes('hep-th'));
});

test("a subarea's progress is its own while it has a group, and its area's after", () => {
  const input = memory({ selected: ['quant-ph', 'hep-th'], examples: [...examples('hep-th', 1), ...examples('quant-ph', 10)] });
  const progress = interestProgress(input);
  assert.equal(progress['quant-ph'], 1);
  assert.ok(Math.abs(progress['hep-th'] - 1 / 3) < 1e-9);
  assert.ok(Math.abs(planInterestGroups(input).groups.find(group => group.categories.includes('hep-th'))!.weight - 2 / 3) < 1e-9);
});

test('a deselected subarea sleeps: no lane, no example category and none of its examples', () => {
  const dormant = examples('hep-th', 5);
  const plan = planInterestGroups(memory({
    selected: ['quant-ph'],
    deselected: ['hep-th'],
    examples: [...dormant, ...examples('quant-ph', 10)],
  }));
  const sent = [...plan.groups.flatMap(group => [...group.categories, ...group.exampleCategories, ...group.positiveIds]), ...plan.unassignedPositiveIds];
  assert.ok(plan.groups.length > 0);
  assert.equal(sent.includes('hep-th'), false);
  assert.equal(dormant.some(example => sent.includes(example.id)), false);
});

test("a deselected subarea's examples do not teach its area", () => {
  const progress = interestProgress(memory({ selected: ['quant-ph'], deselected: ['hep-th'], examples: examples('hep-th', 8) }));
  assert.deepEqual(progress, { 'quant-ph': 0 });
});

test('an area selected again comes back with the examples it kept', () => {
  const kept = [...examples('quant-ph', 12), ...examples('hep-th', 12)];
  const plan = planInterestGroups(memory({ selected: ['quant-ph', 'hep-th'], examples: kept }));
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].weight, 1);
  assert.deepEqual(plan.groups[0].positiveIds, kept.map(example => example.id));
});

test('every group keeps a lane when the lanes run short', () => {
  const plan = planInterestGroups(memory({
    selected: [...leaves('physics'), ...leaves('econ')],
    examples: examples('econ.EM', 8),
  }));
  const econ = plan.groups.filter(group => group.categories.some(category => category.startsWith('econ.')));
  const lanes = new Set(plan.groups.flatMap(group => group.categories));
  assert.equal(econ.length, 3);
  assert.ok(econ.every(group => group.categories.length >= 1));
  assert.equal(lanes.size, 10);
});

test('spare lanes follow the weights, largest remainder first', () => {
  const plan = planInterestGroups(memory({
    selected: [...leaves('physics'), ...leaves('math')],
    examples: examples('math', 8),
  }));
  // Eight spare lanes at 2:1 are 5.33 and 2.67: the larger remainder takes the last one.
  assert.deepEqual(plan.groups.map(group => ({ lanes: group.categories.length, weight: group.weight })), [
    { lanes: 6, weight: 2 },
    { lanes: 4, weight: 1 },
  ]);
});

test('lanes a group cannot use go to the others', () => {
  const plan = planInterestGroups(memory({
    selected: ['quant-ph', 'hep-th', ...leaves('math')],
    examples: examples('math', 8),
  }));
  assert.deepEqual(plan.groups.map(group => group.categories.length), [2, 8]);
});

test('with more groups than lanes the heaviest stay, and ties keep the order of the selection', () => {
  const plan = planInterestGroups(memory({
    selected: ['quant-ph', 'econ.GN', 'econ.EM', 'econ.TH'],
    examples: examples('econ.TH', 8),
  }), { maxLanes: 2 });
  assert.deepEqual(plan.groups.map(group => group.categories), [['quant-ph'], ['econ.GN']]);
});

test('a learned area whose subareas are all new is one group of weight 1', () => {
  const four = leaves('physics').slice(0, 4);
  const plan = planInterestGroups(memory({ selected: four, exposure: shown(Object.fromEntries(four.map(leaf => [leaf, 15]))) }));
  assert.deepEqual(plan.groups.map(group => ({ categories: [...group.categories].sort(), weight: group.weight })), [
    { categories: [...four].sort(), weight: 1 },
  ]);
});

test("an area's own examples count for the area, never for one subarea", () => {
  const workingPapers = examples('econ', 8);
  const input = memory({ selected: ['econ.EM', 'econ.GN'], examples: workingPapers });
  const plan = planInterestGroups(input);
  assert.deepEqual(plan.groups.map(group => group.weight), [1]);
  assert.deepEqual(plan.groups[0].positiveIds, workingPapers.map(example => example.id));
  assert.deepEqual(interestProgress(input), { 'econ.EM': 1, 'econ.GN': 1 });
});

test('examples with no area fill the room the groups leave', () => {
  const plan = planInterestGroups(memory({
    selected: ['quant-ph'],
    examples: [...examples('', 2, 'article'), ...examples('quant-ph', 2), ...examples('cs.RO', 2)],
  }));
  assert.deepEqual(plan.unassignedPositiveIds, ['article-0', 'article-1']);
  assert.deepEqual(plan.groups[0].positiveIds, ['quant-ph-0', 'quant-ph-1']);
});

// q-bio.NC left the taxonomy on 2026-07-11, and accounts still hold it.
test('a selected leaf retired from the taxonomy still asks for its area', () => {
  const plan = planInterestGroups(memory({ selected: ['q-bio.NC'] }));
  assert.equal(plan.groups.length, 1);
  assert.ok(plan.groups[0].categories.includes('q-bio.NC'));
  assert.ok(plan.groups[0].exampleCategories.includes('bio.neuro'));
  assert.ok(activeCategories(['q-bio.NC'], []).has('q-bio.NC'));
});

test('a retired leaf shares the group of its current area', () => {
  const plan = planInterestGroups(memory({ selected: ['q-bio.NC', 'bio.gen'] }));
  assert.deepEqual(plan.groups.map(group => [...group.categories].sort()), [['bio.gen', 'q-bio.NC']]);
});

test('a retired leaf stays in its area group once the area is learned', () => {
  const plan = planInterestGroups(memory({ selected: ['q-bio.NC', 'bio.gen', 'bio.mol'], examples: examples('bio.gen', 8) }));
  assert.deepEqual(plan.groups.map(group => [...group.categories].sort()), [['bio.gen', 'q-bio.NC'], ['bio.mol']]);
});

test("a retired leaf's own exposure does not teach its area, but its examples do", () => {
  const weight = (input: Partial<InterestMemoryInput>) => planInterestGroups(memory({ selected: ['q-bio.NC'], ...input })).groups[0].weight;
  assert.equal(weight({ exposure: shown({ 'q-bio.NC': 60 }) }), 2);
  assert.equal(weight({ examples: examples('q-bio.NC', 4) }), 1.5);
});

test("a retired leaf's examples teach its area, never the leaf alone", () => {
  const plan = planInterestGroups(memory({ selected: ['q-bio.NC', 'bio.gen'], examples: examples('q-bio.NC', 8) }));
  assert.deepEqual(plan.groups.map(group => ({ categories: [...group.categories].sort(), weight: group.weight })), [
    { categories: ['bio.gen', 'q-bio.NC'], weight: 1 },
  ]);
});

test('an id with no area is left out', () => {
  const plan = planInterestGroups(memory({ selected: ['nonsense.XX', 'quant-ph'] }));
  assert.deepEqual(plan.groups.map(group => group.categories), [['quant-ph']]);
  assert.deepEqual(interestProgress(memory({ selected: ['nonsense.XX'] })), {});
});
