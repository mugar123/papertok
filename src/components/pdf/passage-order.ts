import { toEpochMillis } from '../../utils/public-list-freshness.ts';

/**
 * Newest first, so a note just written sits at the top of the list. A highlight
 * saved in this session has no `createdAt` until the server stamps it, which
 * makes it the newest; among several of those, the one saved last comes first.
 */
export function newestFirst<T extends { createdAt?: unknown }>(passages: readonly T[]): T[] {
  const created = (passage: T) => (passage.createdAt === undefined ? Infinity : toEpochMillis(passage.createdAt));
  return passages
    .map((passage, index) => ({ passage, index }))
    .sort((a, b) => (created(b.passage) - created(a.passage)) || b.index - a.index)
    .map(({ passage }) => passage);
}
