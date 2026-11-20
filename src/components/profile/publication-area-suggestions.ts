import type { Paper } from '../../models/paper.ts';
import { getAreaLeaves } from '../../data/category-taxonomy.ts';
import { areaKeyForOpenAlexTopic, leavesForOpenAlexTopic } from '../../utils/area-accent.ts';

export function publicationAreas(papers: Paper[], preferences: string[]) {
  const followed = new Set(preferences);
  const areas = new Set<string>();
  for (const paper of papers) {
    for (const topic of [paper.primaryTopic, ...(paper.topics ?? [])]) {
      if (!topic) continue;
      const leaves = leavesForOpenAlexTopic(topic, true);
      const id = leaves.length === 1 ? leaves[0] : areaKeyForOpenAlexTopic(topic);
      if (id && !followed.has(id)) areas.add(id);
    }
  }
  const covered = new Set<string>();
  for (const id of areas) {
    const leaves = getAreaLeaves(id);
    if (leaves?.every(leaf => followed.has(leaf))) areas.delete(id);
    leaves?.forEach(leaf => covered.add(leaf));
  }
  return [...areas].filter(id => !covered.has(id));
}

export function suggestedInterests(areas: string[]) {
  return areas.flatMap(id => getAreaLeaves(id) ?? [id]);
}
