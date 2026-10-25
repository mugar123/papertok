import { getAllLeafCategories, getCategoryArea } from '../data/categories.ts';
import { areaKeyForCategory } from './area-accent.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from './feed-interactions.ts';
import type { CategoryExposure, PositiveExample } from './interaction-profile.ts';
import { rankPreferences } from './preference-ranking.ts';

/**
 * The interest groups the feed asks the Worker for (ENG-137): each area the
 * reader picked is ranked by its own examples, with a share of the page that
 * shrinks as the app learns it.
 *
 * An area is new until it has AREA_LEARNED_EXAMPLES examples or has shown
 * AREA_LEARNED_SHOWN cards, whichever comes first, and weighs from
 * NEW_AREA_WEIGHT down to 1 on the way. A subarea picked inside a learned area
 * is a group of its own, weighing from 1 down to 0 against
 * SUBAREA_LEARNED_EXAMPLES and SUBAREA_LEARNED_SHOWN; once learned it joins
 * its area's group, so no group ever weighs 0.
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
  // Newest first.
  examples: PositiveExample[];
  exposure: Record<string, CategoryExposure>;
  affinities: Record<string, number>;
}

export interface InterestGroup { categories: string[]; exampleCategories: string[]; positiveIds: string[]; weight: number }

interface PlannedGroup extends InterestGroup { ownSubarea: boolean }

/**
 * Every subarea of an area with a selected subarea, less the deselected
 * ones. A deselected subarea sleeps: it keeps its examples but leaves the
 * feed, its exploration included.
 */
export function activeCategories(selected: string[], deselected: string[]) {
  const dormant = new Set(deselected);
  const areas = new Set(selected.filter(id => !dormant.has(id)).map(getCategoryArea));
  return new Set(getAllLeafCategories().filter(leaf => areas.has(leaf.area) && !dormant.has(leaf.id)).map(leaf => leaf.id));
}

const progressOf = (examples: number, shown: number, learnedExamples: number, learnedShown: number) =>
  Math.min(1, Math.max(examples / learnedExamples, shown / learnedShown));

// One entry per active area, in the order the selection first names it.
function readAreas({ selected, deselected, examples, exposure, affinities }: InterestMemoryInput) {
  const dormant = new Set(deselected);
  const chosen = [...new Set(selected)].filter(id => !dormant.has(id) && getCategoryArea(id));
  const active = activeCategories(chosen, deselected);
  const areaKeys = [...new Set(chosen.map(id => getCategoryArea(id)!))];
  const shownIn = (category: string) => exposure[category]?.shown ?? 0;
  const subareaProgress = (subarea: string) =>
    progressOf(examples.filter(example => example.category === subarea).length, shownIn(subarea), SUBAREA_LEARNED_EXAMPLES, SUBAREA_LEARNED_SHOWN);

  return areaKeys.map((area) => {
    const activeLeaves = getAllLeafCategories().filter(leaf => leaf.area === area && active.has(leaf.id)).map(leaf => leaf.id);
    // An example filed under the area itself (a working paper's 'econ') or an
    // unlisted archive counts for the area, never for one subarea.
    const areaExamples = examples.filter(example => areaKeyForCategory(example.category) === area && !dormant.has(example.category));
    const shown = activeLeaves.reduce((total, leaf) => total + shownIn(leaf), 0);
    const progress = progressOf(areaExamples.length, shown, AREA_LEARNED_EXAMPLES, AREA_LEARNED_SHOWN);
    const subareas = rankPreferences(chosen.filter(id => getCategoryArea(id) === area), affinities);
    const group = (categories: string[], weight: number, ownSubarea = false): PlannedGroup =>
      ({ categories, exampleCategories: activeLeaves, positiveIds: areaExamples.map(example => example.id), weight, ownSubarea });

    let groups: PlannedGroup[];
    if (progress < 1) {
      groups = [group(subareas, NEW_AREA_WEIGHT - (NEW_AREA_WEIGHT - 1) * progress)];
    } else {
      const learned = subareas.filter(subarea => subareaProgress(subarea) >= 1);
      groups = learned.length === 0
        ? [group(subareas, 1)]
        : [
            group(learned, 1),
            ...subareas.filter(subarea => !learned.includes(subarea)).map(subarea => group([subarea], 1 - subareaProgress(subarea), true)),
          ];
    }
    return { progress, groups, subareaProgress };
  });
}

/**
 * How far the app has learned each selected subarea, from 0 to 1: its own
 * progress while it is a group of its own, its area's once it is part of the
 * area's group.
 */
export function interestProgress(input: InterestMemoryInput) {
  const progress: Record<string, number> = {};
  for (const area of readAreas(input)) {
    for (const group of area.groups) {
      for (const subarea of group.categories) progress[subarea] = group.ownSubarea ? area.subareaProgress(subarea) : area.progress;
    }
  }
  return progress;
}

/**
 * Lanes for each group: one each, and those left shared among area groups by
 * weight, largest remainder first. A group never takes more lanes than it has
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
 * stay, ties going to the order of the selection. Each group's area group
 * comes before its subarea groups, since the Worker gives a tie to the first.
 *
 * Each group takes its weight's share of `maxPositives` (at least one when it
 * has any) from its area's newest examples, and examples of no area fill
 * whatever room the groups leave.
 */
export function planInterestGroups(
  input: InterestMemoryInput,
  { maxLanes = MAIN_CATEGORIES, maxPositives = SEMANTIC_PROFILE_POSITIVE_CAP }: { maxLanes?: number; maxPositives?: number } = {},
) {
  const planned = readAreas(input).flatMap(area => area.groups);
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
