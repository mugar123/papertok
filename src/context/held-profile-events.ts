import type { CuratedSetName, InteractionEvent, InteractionProfile } from '../utils/interaction-profile.ts';
import type { MarkName } from './write-mark.ts';

import { curatedIds, recordInteractionEvent } from '../utils/interaction-profile.ts';
import { markKey } from './write-mark.ts';

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

// The mark an event of a like, read or Read later change moves, and the
// curated set the profile stores it in.
function markMoved({ kind }: InteractionEvent): [MarkName, CuratedSetName] | null {
  if (kind === 'like' || kind === 'unlike') return ['like', 'liked'];
  if (kind === 'read' || kind === 'unread') return ['read', 'read'];
  if (kind === 'readLater') return ['readLater', 'readLater'];
  return null;
}

/**
 * For markChanges' screenReplaced, from the profile of `userId` that just
 * arrived, read before replayHeldEvents: the value a like, read or Read later
 * mark whose changes still wait started from. Until the profile loads, a
 * paper marked in an earlier session shows unmarked, and a tap on it starts
 * from there. When each event held for the mark is a change still waiting
 * (`shown` of them), they all started from what the profile stores, so a
 * refusal leaves the mark as stored. Otherwise an earlier change of the wait
 * was answered and shown, and the mark keeps the value it started from.
 */
export function heldMarkStarts(held: HeldProfileEvents | null, userId: string, profile: InteractionProfile) {
  const marks = new Map<string, { stored: boolean; held: number }>();
  if (held?.userId === userId) {
    held.events.forEach(({ event }) => {
      const moved = markMoved(event);
      if (!moved) return;
      const key = markKey(userId, moved[0], event.paperId);
      const mark = marks.get(key) ?? { stored: curatedIds(profile, moved[1]).includes(event.paperId), held: 0 };
      mark.held += 1;
      marks.set(key, mark);
    });
  }
  return (key: string, shown: number) => {
    const mark = marks.get(key);
    return mark?.held === shown ? mark.stored : undefined;
  };
}
