import { getAllLeafCategories, getCategoryArea } from '../data/categories.ts';
import { areaKeyForCategory } from './area-accent.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from './feed-interactions.ts';
import type { CategoryExposure, PositiveExample } from './interaction-profile.ts';
import { rankPreferences } from './preference-ranking.ts';

/**
 * The interest groups the feed asks the Worker for (ENG-137). The interests
 * the reader picked at onboarding, and the ones the app has learned, are one
 * established group of weight 1, ranked by the reader's examples across its
 * lanes as the feed always was.
 *
 * Only what the reader adds by editing their interests starts with priority
 * while the app learns it. An added area (every selected subarea of it added)
 * is new until it has AREA_LEARNED_EXAMPLES examples or has shown
 * AREA_LEARNED_SHOWN cards, whichever comes first, and is a group of its own
 * weighing from NEW_AREA_WEIGHT down to 1 on the way. A subarea added to an
 * area that is not new is a group of its own, weighing from 1 down to 0
 * against SUBAREA_LEARNED_EXAMPLES and SUBAREA_LEARNED_SHOWN. Once learned,
 * either joins the established group, so no group ever weighs 0.
 */
export const NEW_AREA_WEIGHT = 2;
export const AREA_LEARNED_EXAMPLES = 8;
export const AREA_LEARNED_SHOWN = 60;
export const SUBAREA_LEARNED_EXAMPLES = 3;
export const SUBAREA_LEARNED_SHOWN = 20;
// Categories one feed request asks for; the Worker accepts up to 12.
export const MAIN_CATEGORIES = 10;

export interface InterestMemoryInput {
  selected: string[];
  deselected: string[];
  // The subareas the reader added after onboarding (nextAdded).
  added: string[];
  // Newest first.
  examples: PositiveExample[];
  exposure: Record<string, CategoryExposure>;
  affinities: Record<string, number>;
}

export interface InterestGroup { categories: string[]; exampleCategories: string[]; positiveIds: string[]; weight: number }

interface PlannedGroup extends InterestGroup { ownSubarea: boolean }

// The selected ids that place in an area, less the deselected ones. An id
// retired from the taxonomy (q-bio.NC, eess.AS) is still stored by accounts
// that picked it, and places by its archive.
function chosenIds(selected: string[], dormant: Set<string>) {
  return [...new Set(selected)].filter(id => !dormant.has(id) && areaKeyForCategory(id));
}

/**
 * Every subarea of an area with a selected subarea, less the deselected
 * ones, and any selected id retired from the taxonomy. A deselected subarea
 * sleeps: it keeps its examples but leaves the feed, its exploration included.
 */
export function activeCategories(selected: string[], deselected: string[]) {
  const dormant = new Set(deselected);
  const chosen = chosenIds(selected, dormant);
  const areas = new Set<string | null>(chosen.map(areaKeyForCategory));
  return new Set([
    ...getAllLeafCategories().filter(leaf => areas.has(leaf.area) && !dormant.has(leaf.id)).map(leaf => leaf.id),
    ...chosen.filter(id => !getCategoryArea(id)),
  ]);
}

/**
 * The subareas a reader has removed from their interests: the ones already
 * removed plus the ones this edit drops, less any selected again. Earlier
 * removals come first so the stored list only grows at its end.
 */
export function nextDeselected(previousSelected: string[], nextSelected: string[], previousDeselected: string[]) {
  const selected = new Set(nextSelected);
  const removedNow = previousSelected.filter(id => !selected.has(id));
  return [...new Set([...previousDeselected, ...removedNow])].filter(id => !selected.has(id));
}

/**
 * The subareas a reader has added to their interests since onboarding: the
 * ones added before and still selected, then the ones this edit selects for
 * the first time. A pick made at onboarding is never in it.
 */
export function nextAdded(previousSelected: string[], nextSelected: string[], previousAdded: string[]) {
  const selected = new Set(nextSelected);
  const before = new Set(previousSelected);
  return [...new Set([...previousAdded.filter(id => selected.has(id)), ...nextSelected.filter(id => !before.has(id))])];
}

const progressOf = (examples: number, shown: number, learnedExamples: number, learnedShown: number) =>
  Math.min(1, Math.max(examples / learnedExamples, shown / learnedShown));

/**
 * The planned groups, established first, with how far the app has learned
 * each selected subarea and the ones still cold-added (a group of their own).
 */
function readInterests({ selected, deselected, added, examples, exposure, affinities }: InterestMemoryInput) {
  const dormant = new Set(deselected);
  const chosen = chosenIds(selected, dormant);
  const active = activeCategories(chosen, deselected);
  const addedIds = new Set(added);
  const areaKeys = [...new Set(chosen.map(id => areaKeyForCategory(id)!))];
  const shownIn = (category: string) => exposure[category]?.shown ?? 0;
  const subareaProgress = (subarea: string) =>
    progressOf(examples.filter(example => example.category === subarea).length, shownIn(subarea), SUBAREA_LEARNED_EXAMPLES, SUBAREA_LEARNED_SHOWN);
  // An example filed under the area itself (a working paper's 'econ') or an
  // unlisted archive counts for the area, never for one subarea.
  const examplesOf = (areas: Set<string>) =>
    examples.filter(example => areas.has(areaKeyForCategory(example.category) ?? '') && !dormant.has(example.category)).map(example => example.id);

  const progress: Record<string, number> = {};
  const established = new Set<string>();
  const establishedAreas = new Set<string>();
  const cold: PlannedGroup[] = [];
  for (const area of areaKeys) {
    const retired = chosen.filter(id => areaKeyForCategory(id) === area && !getCategoryArea(id));
    const activeLeaves = [...getAllLeafCategories().filter(leaf => leaf.area === area && active.has(leaf.id)).map(leaf => leaf.id), ...retired];
    // A retired id has no exposure of its own; its examples count for the area.
    const shown = activeLeaves.filter(leaf => !retired.includes(leaf)).reduce((total, leaf) => total + shownIn(leaf), 0);
    const areaProgress = progressOf(examplesOf(new Set([area])).length, shown, AREA_LEARNED_EXAMPLES, AREA_LEARNED_SHOWN);
    const subareas = rankPreferences(chosen.filter(id => areaKeyForCategory(id) === area), affinities);
    const coldGroup = (categories: string[], weight: number, ownSubarea: boolean): PlannedGroup =>
      ({ categories, exampleCategories: activeLeaves, positiveIds: examplesOf(new Set([area])), weight, ownSubarea });

    if (areaProgress < 1 && subareas.every(subarea => addedIds.has(subarea))) {
      cold.push(coldGroup(subareas, NEW_AREA_WEIGHT - (NEW_AREA_WEIGHT - 1) * areaProgress, false));
      for (const subarea of subareas) progress[subarea] = areaProgress;
      continue;
    }
    for (const subarea of subareas) {
      // A retired id never learns on its own, so it stays established.
      const own = retired.includes(subarea) ? 1 : subareaProgress(subarea);
      if (addedIds.has(subarea) && own < 1) {
        cold.push(coldGroup([subarea], 1 - own, true));
        progress[subarea] = own;
      } else {
        established.add(subarea);
        establishedAreas.add(area);
        progress[subarea] = areaProgress;
      }
    }
  }

  const groups: PlannedGroup[] = established.size === 0 ? cold : [{
    categories: rankPreferences(chosen.filter(id => established.has(id)), affinities),
    exampleCategories: [...active],
    positiveIds: examplesOf(establishedAreas),
    weight: 1,
    ownSubarea: false,
  }, ...cold];
  return { groups, progress, coldAdded: cold.flatMap(group => group.categories) };
}

/**
 * How far the app has learned each selected subarea, from 0 to 1: its own
 * progress while it is a group of its own, its area's otherwise.
 */
export function interestProgress(input: InterestMemoryInput) {
  return readInterests(input).progress;
}

/** The added subareas that are still a group of their own: the scoring weighs them by their progress. */
export function coldAddedInterests(input: InterestMemoryInput) {
  return readInterests(input).coldAdded;
}

/**
 * Lanes for each group: one each, and those left shared among the groups
 * that are not a single added subarea by weight, largest remainder first. A group never takes more lanes than it has
 * categories; what it cannot take goes round again to the others.
 */
function shareLanes(groups: PlannedGroup[], maxLanes: number) {
  const lanes = groups.map(() => 1);
  let left = maxLanes - groups.length;
  while (left > 0) {
    const open = groups.flatMap((group, index) => (!group.ownSubarea && lanes[index] < group.categories.length ? [index] : []));
    if (open.length === 0) break;
    const total = open.reduce((sum, index) => sum + groups[index].weight, 0);
    const exact = new Map(open.map(index => [index, left * groups[index].weight / total]));
    const wanted = new Map(open.map(index => [index, Math.floor(exact.get(index)!)]));
    const remainders = [...open].sort((a, b) => (exact.get(b)! % 1) - (exact.get(a)! % 1) || a - b);
    const extra = left - [...wanted.values()].reduce((sum, value) => sum + value, 0);
    remainders.slice(0, extra).forEach(index => wanted.set(index, wanted.get(index)! + 1));
    for (const index of open) {
      const given = Math.min(wanted.get(index)!, groups[index].categories.length - lanes[index]);
      lanes[index] += given;
      left -= given;
    }
  }
  return lanes;
}

/**
 * The groups of one feed request. With more groups than lanes the heaviest
 * stay, ties going to the order of the selection. The established group comes
 * first, since the Worker gives an area's article to the first on a tie.
 *
 * Each group takes its weight's share of `maxPositives` (at least one when it
 * has any) from its area's newest examples, and examples of no area fill
 * whatever room the groups leave.
 */
export function planInterestGroups(
  input: InterestMemoryInput,
  { maxLanes = MAIN_CATEGORIES, maxPositives = SEMANTIC_PROFILE_POSITIVE_CAP }: { maxLanes?: number; maxPositives?: number } = {},
) {
  const planned = readInterests(input).groups;
  const selection = (group: PlannedGroup) => Math.min(...group.categories.map(category => input.selected.indexOf(category)));
  const kept = new Set([...planned]
    .sort((a, b) => b.weight - a.weight || selection(a) - selection(b))
    .slice(0, Math.max(0, maxLanes)));
  const groups = planned.filter(group => kept.has(group));

  const lanes = shareLanes(groups, maxLanes);
  const totalWeight = groups.reduce((sum, group) => sum + group.weight, 0);
  const quotas = groups.map(group => Math.max(1, Math.floor(maxPositives * group.weight / totalWeight)));
  const union = new Set<string>();
  const admit = (id: string) => {
    if (!union.has(id) && union.size >= maxPositives) return false;
    union.add(id);
    return true;
  };
  // Every group's newest example first, so the cap never leaves a group with none.
  const positiveIds = groups.map(group => group.positiveIds.slice(0, 1).filter(admit));
  groups.forEach((group, index) => {
    positiveIds[index].push(...group.positiveIds.slice(1, quotas[index]).filter(admit));
  });
  const unassignedPositiveIds = input.examples
    .filter(example => !areaKeyForCategory(example.category))
    .map(example => example.id)
    .filter(admit);

  return {
    groups: groups.map((group, index): InterestGroup => ({
      categories: group.categories.slice(0, lanes[index]),
      exampleCategories: [...group.exampleCategories],
      positiveIds: positiveIds[index],
      weight: group.weight,
    })),
    unassignedPositiveIds,
  };
}
