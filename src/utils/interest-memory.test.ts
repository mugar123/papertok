import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../data/categories.ts';
import type { CategoryExposure, PositiveExample } from './interaction-profile.ts';
import { activeCategories, coldAddedInterests, interestProgress, nextAdded, nextDeselected, planInterestGroups, type InterestMemoryInput } from './interest-memory.ts';

const leaves = (area: string) => Object.keys(CATEGORIES[area].subcategories);

const examples = (category: string, count: number, prefix = category) =>
  Array.from({ length: count }, (_, index): PositiveExample => ({ id: `${prefix}-${index}`, category }));

const shown = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).map(([category, count]): [string, CategoryExposure] => [category, { shown: count, engaged: 0 }]));

const memory = (input: Partial<InterestMemoryInput>): InterestMemoryInput => ({
  selected: [], deselected: [], added: [], examples: [], exposure: {}, affinities: {}, ...input,
});

const areaOf = (category: string) => Object.keys(CATEGORIES).find(area => category in CATEGORIES[area].subcategories);

const weightsByArea = (input: InterestMemoryInput) =>
  Object.fromEntries(planInterestGroups(input).groups.map(group => [areaOf(group.categories[0]), group.weight]));

test('an active area is every subarea of a selected area except the deselected ones', () => {
  const active = activeCategories(['hep-th'], ['quant-ph']);
  assert.deepEqual([...active].sort(), leaves('physics').filter(leaf => leaf !== 'quant-ph').sort());
});

test('an added area weighs twice the established interests', () => {
  const input = memory({ selected: ['quant-ph', 'econ.EM'], added: ['econ.EM'], examples: examples('quant-ph', 10) });
  assert.deepEqual(weightsByArea(input), { physics: 1, econ: 2 });
});

test('the established group takes its share of the examples and the rest go unused', () => {
  const plan = planInterestGroups(memory({ selected: ['quant-ph', 'econ.EM'], added: ['econ.EM'], examples: examples('quant-ph', 10) }));
  const physics = plan.groups.find(group => group.categories.includes('quant-ph'))!;
  // 24 × 1/3: the eight newest.
  assert.deepEqual(physics.positiveIds, examples('quant-ph', 8).map(example => example.id));
});

test("an added area's weight falls from 2 to 1 with its examples or the cards it showed", () => {
  const weight = (input: Partial<InterestMemoryInput>) => planInterestGroups(memory({ selected: ['econ.EM'], added: ['econ.EM'], ...input })).groups[0].weight;
  assert.equal(weight({ examples: examples('econ.EM', 4) }), 1.5);
  assert.equal(weight({ examples: examples('econ.EM', 8) }), 1);
  assert.equal(weight({ exposure: shown({ 'econ.EM': 60 }) }), 1);
});

test('a subarea added to an established area is a group of weight 1 until it learns', () => {
  const learned = examples('quant-ph', 10);
  const plan = planInterestGroups(memory({ selected: ['quant-ph', 'hep-th'], added: ['hep-th'], examples: learned }));
  assert.deepEqual(plan.groups.map(group => ({ categories: group.categories, weight: group.weight })), [
    { categories: ['quant-ph'], weight: 1 },
    { categories: ['hep-th'], weight: 1 },
  ]);
  assert.deepEqual([...plan.groups[1].exampleCategories].sort(), [...leaves('physics')].sort());

  const joined = planInterestGroups(memory({ selected: ['quant-ph', 'hep-th'], added: ['hep-th'], examples: [...examples('hep-th', 3), ...learned] }));
  assert.equal(joined.groups.length, 1);
  assert.ok(joined.groups[0].categories.includes('hep-th'));
});

test("an added subarea's progress is its own while it has a group, and its area's after", () => {
  const input = memory({ selected: ['quant-ph', 'hep-th'], added: ['hep-th'], examples: [...examples('hep-th', 1), ...examples('quant-ph', 10)] });
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
    added: ['econ.GN', 'econ.TH'],
    examples: examples('econ.EM', 8),
  }));
  const lanes = new Set(plan.groups.flatMap(group => group.categories));
  assert.deepEqual(plan.groups.slice(1).map(group => group.categories), [['econ.GN'], ['econ.TH']]);
  assert.equal(plan.groups[0].categories.length, 8);
  assert.equal(lanes.size, 10);
});

test('spare lanes follow the weights, largest remainder first', () => {
  const plan = planInterestGroups(memory({
    selected: [...leaves('physics'), ...leaves('math')],
    added: leaves('physics'),
    examples: examples('math', 8),
  }));
  // Eight spare lanes at 1:2 are 2.67 and 5.33: the larger remainder takes the last one.
  assert.deepEqual(plan.groups.map(group => ({ lanes: group.categories.length, weight: group.weight })), [
    { lanes: 4, weight: 1 },
    { lanes: 6, weight: 2 },
  ]);
});

test('lanes a group cannot use go to the others', () => {
  const plan = planInterestGroups(memory({
    selected: ['quant-ph', 'hep-th', ...leaves('math')],
    added: ['quant-ph', 'hep-th'],
    examples: examples('math', 8),
  }));
  assert.deepEqual(plan.groups.map(group => group.categories.length), [8, 2]);
});

test('with more groups than lanes the heaviest stay, and ties keep the order of the selection', () => {
  const plan = planInterestGroups(memory({
    selected: ['quant-ph', 'econ.GN', 'econ.EM', 'econ.TH'],
    added: ['quant-ph', 'econ.GN', 'econ.EM'],
    examples: examples('econ.TH', 8),
  }), { maxLanes: 2 });
  assert.deepEqual(plan.groups.map(group => group.categories), [['quant-ph'], ['econ.GN']]);
});

test('an established area whose subareas are all unread is one group of weight 1', () => {
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

test('a retired leaf stays in the established group beside an added subarea', () => {
  const plan = planInterestGroups(memory({ selected: ['q-bio.NC', 'bio.gen', 'bio.mol'], added: ['bio.mol'], examples: examples('bio.gen', 8) }));
  assert.deepEqual(plan.groups.map(group => [...group.categories].sort()), [['bio.gen', 'q-bio.NC'], ['bio.mol']]);
});

test("a retired leaf's own exposure does not teach its area, but its examples do", () => {
  const progress = (input: Partial<InterestMemoryInput>) => interestProgress(memory({ selected: ['q-bio.NC'], ...input }))['q-bio.NC'];
  assert.equal(progress({ exposure: shown({ 'q-bio.NC': 60 }) }), 0);
  assert.equal(progress({ examples: examples('q-bio.NC', 4) }), 0.5);
});

test("a retired leaf's examples teach its area, never the leaf alone", () => {
  const input = memory({ selected: ['q-bio.NC', 'bio.gen'], examples: examples('q-bio.NC', 8) });
  assert.deepEqual(interestProgress(input), { 'q-bio.NC': 1, 'bio.gen': 1 });
  assert.deepEqual(planInterestGroups(input).groups.map(group => ({ categories: [...group.categories].sort(), weight: group.weight })), [
    { categories: ['bio.gen', 'q-bio.NC'], weight: 1 },
  ]);
});

test('an id with no area is left out', () => {
  const plan = planInterestGroups(memory({ selected: ['nonsense.XX', 'quant-ph'] }));
  assert.deepEqual(plan.groups.map(group => group.categories), [['quant-ph']]);
  assert.deepEqual(interestProgress(memory({ selected: ['nonsense.XX'] })), {});
});

test('nextDeselected keeps what the reader removes now', () => {
  assert.deepEqual(nextDeselected(['hep-th', 'gr-qc'], ['gr-qc', 'econ.EM'], []), ['hep-th']);
});

test('nextDeselected forgets a subarea the reader selects again', () => {
  assert.deepEqual(nextDeselected(['econ.EM'], ['econ.EM', 'hep-th'], ['hep-th']), []);
});

test('nextDeselected keeps earlier removals first and never repeats one', () => {
  assert.deepEqual(
    nextDeselected(['a', 'b', 'c'], ['c'], ['z', 'b']),
    ['z', 'b', 'a'],
  );
});

// ENG-137, ruling R13: only what the reader adds by editing their interests
// starts with priority; what they picked at onboarding is established.
const groupsOf = (input: InterestMemoryInput) =>
  planInterestGroups(input).groups.map(group => ({ categories: [...group.categories].sort(), weight: group.weight }));

test('a learned area beside onboarding picks it rarely reads is one group of weight 1', () => {
  const plan = planInterestGroups(memory({
    selected: ['cs.AI', 'cs.LG', 'cs.RO', 'cs.HC'],
    examples: examples('cs.LG', 22),
  }));
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].weight, 1);
  assert.deepEqual([...plan.groups[0].categories].sort(), ['cs.AI', 'cs.HC', 'cs.LG', 'cs.RO']);
});

test('an added area with no examples is a group of weight 2 beside the established one', () => {
  assert.deepEqual(groupsOf(memory({
    selected: ['quant-ph', 'hep-th', 'econ.EM', 'econ.GN'],
    added: ['econ.EM', 'econ.GN'],
    examples: examples('quant-ph', 10),
  })), [
    { categories: ['hep-th', 'quant-ph'], weight: 1 },
    { categories: ['econ.EM', 'econ.GN'], weight: 2 },
  ]);
});

test('an added area joins the established group once it has 8 examples', () => {
  const econ = examples('econ.EM', 8);
  const plan = planInterestGroups(memory({
    selected: ['quant-ph', 'econ.EM'],
    added: ['econ.EM'],
    examples: [...econ, ...examples('quant-ph', 10)],
  }));
  assert.deepEqual(plan.groups.map(group => ({ categories: [...group.categories].sort(), weight: group.weight })), [
    { categories: ['econ.EM', 'quant-ph'], weight: 1 },
  ]);
  assert.ok(econ.every(example => plan.groups[0].positiveIds.includes(example.id)));
});

test('a reader who moves from physics to economics asks for economics alone', () => {
  assert.deepEqual(groupsOf(memory({
    selected: ['econ.EM', 'econ.GN'],
    added: ['econ.EM', 'econ.GN'],
    deselected: ['quant-ph', 'hep-th'],
    examples: [...examples('quant-ph', 12), ...examples('hep-th', 12)],
  })), [
    { categories: ['econ.EM', 'econ.GN'], weight: 2 },
  ]);
});

test('physics selected again with what it learned is established, with its examples', () => {
  const physics = [...examples('quant-ph', 12), ...examples('hep-th', 12)];
  const input = memory({
    selected: ['econ.EM', 'quant-ph', 'hep-th'],
    added: ['econ.EM', 'quant-ph', 'hep-th'],
    examples: physics,
  });
  const plan = planInterestGroups(input);
  assert.deepEqual(groupsOf(input), [
    { categories: ['hep-th', 'quant-ph'], weight: 1 },
    { categories: ['econ.EM'], weight: 2 },
  ]);
  assert.ok(plan.groups[0].positiveIds.length > 0);
  assert.ok(plan.groups[0].positiveIds.every(id => physics.some(example => example.id === id)));
  assert.deepEqual(coldAddedInterests(input), ['econ.EM']);
});

test('the established group draws its examples from every active area', () => {
  const plan = planInterestGroups(memory({
    selected: ['quant-ph', 'econ.EM', 'cs.RO'],
    added: ['cs.RO'],
    examples: [...examples('econ.EM', 1), ...examples('quant-ph', 1)],
  }));
  assert.deepEqual(plan.groups[0].positiveIds, ['econ.EM-0', 'quant-ph-0']);
  assert.deepEqual([...plan.groups[0].exampleCategories].sort(), [...activeCategories(['quant-ph', 'econ.EM', 'cs.RO'], [])].sort());
});

test('the cold-added interests are the added ones still learning', () => {
  assert.deepEqual(coldAddedInterests(memory({
    selected: ['quant-ph', 'hep-th', 'econ.EM'],
    added: ['hep-th', 'econ.EM'],
    examples: examples('quant-ph', 10),
  })).sort(), ['econ.EM', 'hep-th']);
  assert.deepEqual(coldAddedInterests(memory({ selected: ['quant-ph'], examples: examples('quant-ph', 1) })), []);
});

test('nextAdded keeps what the reader adds now', () => {
  assert.deepEqual(nextAdded(['quant-ph'], ['quant-ph', 'econ.EM'], []), ['econ.EM']);
});

test('nextAdded never counts an onboarding pick the reader keeps', () => {
  assert.deepEqual(nextAdded(['quant-ph', 'hep-th'], ['hep-th', 'quant-ph'], []), []);
});

test('nextAdded keeps earlier additions still selected, first, and drops removed ones', () => {
  assert.deepEqual(nextAdded(['a', 'b', 'c'], ['b', 'c', 'd'], ['a', 'b']), ['b', 'd']);
});

test('nextAdded never repeats an id', () => {
  assert.deepEqual(nextAdded(['a'], ['a', 'b', 'b'], ['a']), ['a', 'b']);
});

// ENG-137, ruling R11: an old bundle or the onboarding can leave a subarea
// both selected and deselected; the selection is the later intent.
test('a subarea both selected and deselected stays in a group and active', () => {
  const input = memory({ selected: ['quant-ph', 'hep-th'], deselected: ['hep-th'] });
  assert.ok(planInterestGroups(input).groups.some(group => group.categories.includes('hep-th')));
  assert.ok(activeCategories(input.selected, input.deselected).has('hep-th'));
  assert.ok('hep-th' in interestProgress(input));
});

test("a subarea both selected and deselected teaches its area with its examples", () => {
  const input = memory({ selected: ['quant-ph', 'hep-th'], deselected: ['hep-th'], examples: examples('hep-th', 8) });
  assert.deepEqual(interestProgress(input), { 'quant-ph': 1, 'hep-th': 1 });
});

// ENG-137, ruling R15: an added area learned through its area-level evidence
// (working papers filed under 'econ') joins the established group whole. Its
// added subareas split off only beside a subarea established on its own.
const economics = ['econ.EM', 'econ.GN', 'econ.TH'];

test('an added area learned through its own examples joins the established group whole', () => {
  assert.deepEqual(groupsOf(memory({
    selected: ['cs.RO', ...economics],
    added: economics,
    examples: [...examples('econ', 8), ...examples('cs.RO', 10)],
  })), [
    { categories: ['cs.RO', ...economics], weight: 1 },
  ]);
});

test('an added area one example short of learned is still one group of its own', () => {
  assert.deepEqual(groupsOf(memory({
    selected: ['cs.RO', ...economics],
    added: economics,
    examples: [...examples('econ', 7), ...examples('cs.RO', 10)],
  })), [
    { categories: ['cs.RO'], weight: 1 },
    { categories: economics, weight: 2 - 7 / 8 },
  ]);
});

test('a subarea added beside one its area learned on its own is a group of weight 1', () => {
  assert.deepEqual(groupsOf(memory({
    selected: ['quant-ph', 'hep-th'],
    added: ['quant-ph', 'hep-th'],
    examples: [...examples('quant-ph', 3), ...examples('physics', 8)],
  })), [
    { categories: ['quant-ph'], weight: 1 },
    { categories: ['hep-th'], weight: 1 },
  ]);
});

// ENG-137, ruling R14: Chemistry's cards name no subarea, so what they teach
// is recorded under 'chem', and counts for the area.
test('an added area learns from the cards and examples recorded under its own key', () => {
  const chemistry = (input: Partial<InterestMemoryInput>) => memory({
    selected: ['cs.RO', 'chem.org'], added: ['chem.org'], examples: examples('cs.RO', 10), ...input,
  });

  assert.deepEqual(groupsOf(chemistry({ exposure: shown({ chem: 30 }) })), [
    { categories: ['cs.RO'], weight: 1 },
    { categories: ['chem.org'], weight: 1.5 },
  ]);
  const shownSixty = chemistry({ exposure: shown({ chem: 60 }) });
  assert.deepEqual(groupsOf(shownSixty), [{ categories: ['chem.org', 'cs.RO'], weight: 1 }]);
  assert.equal(interestProgress(shownSixty)['chem.org'], 1);

  const eightExamples = chemistry({ examples: [...examples('chem', 8), ...examples('cs.RO', 10)] });
  assert.deepEqual(groupsOf(eightExamples), [{ categories: ['chem.org', 'cs.RO'], weight: 1 }]);
  assert.equal(interestProgress(eightExamples)['chem.org'], 1);
});
