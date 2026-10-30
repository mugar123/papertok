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

/**
 * `held` with `event` of `userId` added. Events of another account are
 * dropped: they never reach this account's profile.
 */
export function holdProfileEvent(held: HeldProfileEvents | null, userId: string, event: InteractionEvent, at = Date.now()): HeldProfileEvents {
  const kept = held?.userId === userId ? held : { userId, events: [] };
  kept.events.push({ event, at });
  return kept;
}

/**
 * Records `held` on the profile of `userId` that just arrived, in the order
 * and at the times they happened, and says whether it recorded any. The
 * stored aggregate cannot hold them already: the feed writes the profile back
 * only once it has loaded. A profile rebuilt from the interaction documents
 * can hold a document written while they were read: its curated id is added
 * once either way, and its category impact counts twice, for the few events
 * of that wait. The rebuild has no lean or engagement counts to count twice.
 */
export function replayHeldEvents(held: HeldProfileEvents | null, userId: string, profile: InteractionProfile) {
  if (held?.userId !== userId || held.events.length === 0) return false;
  held.events.forEach(({ event, at }) => recordInteractionEvent(profile, event, at));
  return true;
}
