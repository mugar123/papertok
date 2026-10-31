import type { InteractionEvent, InteractionProfile } from '../utils/interaction-profile.ts';

import { recordInteractionEvent } from '../utils/interaction-profile.ts';

/**
 * The events an account recorded while its stored profile was still loading,
 * with the time each was recorded. The feed lets the reader in before the
 * profile arrives (INTERACTIONS_NETWORK_TIMEOUT_MS), and their likes, views
 * and saves move the provisional profile in the meantime. The profile that
 * arrives replaces it, so they are kept here to be recorded again on it.
 */
export type HeldProfileEvents = { userId: string; events: Array<{ event: InteractionEvent; at: number }> };

// A load that never ends leaves the feed holding every card the reader passes;
// a wait this long keeps only its latest events.
const MAX_HELD_EVENTS = 500;

/**
 * `held` with `event` of `userId` added. Events of another account are
 * dropped: they never reach this account's profile. Past MAX_HELD_EVENTS the
 * oldest event is dropped.
 *
 * `undoes` is the held event of a change Firestore refused, which `event`
 * takes back on screen. Storage never had that change, so the two cancel and
 * neither is replayed. Replayed, they would not cancel on a profile that
 * already holds the mark: until the profile loads, a paper liked in an earlier
 * session shows unliked, a like of it adds nothing to the stored like, and its
 * undo would remove it. When `undoes` is no longer held, `event` is held.
 */
export function holdProfileEvent(held: HeldProfileEvents | null, userId: string, event: InteractionEvent, at = Date.now(), undoes?: InteractionEvent | null): HeldProfileEvents {
  const kept = held?.userId === userId ? held : { userId, events: [] };
  const undone = undoes ? kept.events.findIndex((entry) => entry.event === undoes) : -1;
  if (undone >= 0) {
    kept.events.splice(undone, 1);
    return kept;
  }
  kept.events.push({ event, at });
  if (kept.events.length > MAX_HELD_EVENTS) kept.events.shift();
  return kept;
}

/**
 * Records `held` on the profile of `userId` that just arrived, in the order
 * and at the times they happened, and says whether it recorded any. The
 * stored aggregate cannot hold them already: the feed writes the profile back
 * only once it has loaded. A profile rebuilt from the interaction documents
 * can already hold the document of an event made while they were read. Its
 * curated id and document count are added once either way, and the rebuild
 * has no lean or engagement counts to count twice, but its category, concept,
 * author and session impacts, its exposure and its dwell count twice. A For
 * You card the rebuild lists as viewed adds no shown when replayed, while a
 * like of it still adds engaged. Both are bounded by the events of that wait.
 */
export function replayHeldEvents(held: HeldProfileEvents | null, userId: string, profile: InteractionProfile) {
  if (held?.userId !== userId || held.events.length === 0) return false;
  held.events.forEach(({ event, at }) => recordInteractionEvent(profile, event, at));
  return true;
}
