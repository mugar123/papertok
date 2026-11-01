import type { CuratedSetName, InteractionEvent, InteractionProfile } from '../utils/interaction-profile.ts';
import type { MarkChanges, MarkName } from './write-mark.ts';

import { curatedIds, recordInteractionEvent } from '../utils/interaction-profile.ts';
import { markKey } from './write-mark.ts';

/**
 * The events an account recorded while its stored profile was still loading,
 * with the time each was recorded. The feed lets the reader in before the
 * profile arrives (INTERACTIONS_NETWORK_TIMEOUT_MS), and their likes, views
 * and saves move the provisional profile in the meantime. The profile that
 * arrives replaces it, so they are kept here to be recorded again on it.
 * `refused` marks the event of a change Firestore refused (refuseHeldEvent).
 */
export type HeldProfileEvents = { userId: string; events: Array<{ event: InteractionEvent; at: number; refused?: boolean }> };

// A load that never ends leaves the feed holding every card the reader passes;
// a wait this long keeps only its latest events.
const MAX_HELD_EVENTS = 500;

// The events held that no loaded profile has recorded (replayHeldEvents).
const unrecorded = new WeakSet<InteractionEvent>();

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
 * undo would remove it. When `undoes` was held and dropped before any profile
 * recorded it, by a sign-out or past MAX_HELD_EVENTS, `event` is dropped too,
 * for the same reason. When `undoes` was never held, `event` is held.
 * FeedProvider marks `undoes` refused (refuseHeldEvent) before its undo
 * comes, which alone keeps it out of the replay; taking it out here as well
 * cancels the pair whatever that order, and frees its place among the
 * MAX_HELD_EVENTS.
 */
export function holdProfileEvent(held: HeldProfileEvents | null, userId: string, event: InteractionEvent, at = Date.now(), undoes?: InteractionEvent | null): HeldProfileEvents {
  const kept = held?.userId === userId ? held : { userId, events: [] };
  const undone = undoes ? kept.events.findIndex((entry) => entry.event === undoes) : -1;
  if (undone >= 0) {
    kept.events.splice(undone, 1);
    return kept;
  }
  if (undoes && unrecorded.has(undoes)) return kept;
  kept.events.push({ event, at });
  unrecorded.add(event);
  if (kept.events.length > MAX_HELD_EVENTS) kept.events.shift();
  return kept;
}

/**
 * Marks the held `event` of a change Firestore refused, which storage never
 * had: it is not replayed. It stays held for an undo that follows to name as
 * `undoes`. Without that undo, nothing else takes it back: the list picker
 * keeps a refused Read later change on screen, a change refused while a
 * newer one to the same mark stands is not undone, such as a like and the
 * unlike after it, both refused, on a paper liked in an earlier session, and
 * a save or dismissal has no undo of its own. A quick save takes a refused
 * save back with an unsave that writes `saved: false`; that unsave names no
 * `undoes`, so it is replayed when storage accepts it and refused with it.
 * A refusal that lands once the profile has arrived finds nothing held: the
 * replay has recorded the event. The undo of a like, an unlike, a Reading
 * history removal or a Read later change takes it back when it runs; a save,
 * an unsave, a dismissal or its undo stays in the profile, as any such change
 * refused after the load does, unless its caller makes the opposite change.
 */
export function refuseHeldEvent(held: HeldProfileEvents | null, event: InteractionEvent) {
  const entry = held?.events.find((candidate) => candidate.event === event);
  if (entry) entry.refused = true;
}

/**
 * Records `held` on the profile of `userId` that just arrived, in the order
 * and at the times they happened, and says whether it recorded any. The
 * stored aggregate cannot hold these events: the feed writes the profile back
 * only once it has loaded. It can hold a mark one of them sets again, from an
 * earlier session: such a like, save or dismissal is left out (holdsAlready).
 * So is a refused change's event.
 *
 * A profile rebuilt from the interaction documents can already hold the
 * document of an event made while they were read. A like, save or dismissal
 * it holds is then left out, with its engagement count and lean step, which
 * the rebuild starts from zero anyway. Another event adds its curated id and
 * document count once, but the category, concept, author and session impacts,
 * exposure and dwell of a view, a skip or a PDF open count twice; a For You
 * card the rebuild lists as viewed adds no shown. Both are bounded by the
 * events of that wait.
 */
export function replayHeldEvents(held: HeldProfileEvents | null, userId: string, profile: InteractionProfile) {
  if (held?.userId !== userId) return false;
  let recorded = false;
  held.events.forEach(({ event, at, refused }) => {
    if (refused || holdsAlready(profile, event)) return;
    recordInteractionEvent(profile, event, at);
    unrecorded.delete(event);
    recorded = true;
  });
  return recorded;
}

// The curated set each toggle puts its paper in (true) or takes it out of.
const TOGGLES = new Map<string, [CuratedSetName, boolean]>([
  ['like', ['liked', true]], ['unlike', ['liked', false]],
  ['save', ['saved', true]], ['unsave', ['saved', false]],
  ['notInterested', ['notInterested', true]], ['undoNotInterested', ['notInterested', false]],
]);

// Until the profile loads, a paper liked, saved or dismissed in an earlier
// session shows without its mark, and a tap on it toggles a mark storage
// already has. Replayed, its impact on the paper's category, concepts and
// authors would count twice.
function holdsAlready(profile: InteractionProfile, { kind, paperId }: InteractionEvent) {
  const toggle = TOGGLES.get(kind);
  return toggle !== undefined && curatedIds(profile, toggle[0]).includes(paperId) === toggle[1];
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
 * from there. When each event held for the mark, but a refused one, is a
 * change still waiting (`shown` of them), they all started from what the
 * profile stores, so a refusal leaves the mark as stored. Otherwise an
 * earlier change of the wait was accepted and shown, and the mark keeps the
 * value it started from.
 */
function heldMarkStarts(held: HeldProfileEvents | null, userId: string, profile: InteractionProfile) {
  const marks = new Map<string, { stored: boolean; held: number }>();
  if (held?.userId === userId) {
    held.events.forEach(({ event, refused }) => {
      const moved = markMoved(event);
      if (!moved || refused) return;
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

/**
 * What the feed does with `held` when the profile of `userId` arrives. It
 * reads what the profile stores of the marks the held events moved
 * (heldMarkStarts), records the held events on it (replayHeldEvents) and,
 * when they added anything, calls `flush` to write it back, so they reach
 * storage without waiting for the reader's next event. The screen then shows
 * the profile's marks, so `changes` learns that what earlier answers sent to
 * it is gone, and what the marks still waiting on a write started from.
 */
export function adoptHeldEvents(held: HeldProfileEvents | null, userId: string, profile: InteractionProfile, { changes, flush }: { changes: Pick<MarkChanges, 'screenReplaced'>; flush: () => void }) {
  const markStarts = heldMarkStarts(held, userId, profile);
  if (replayHeldEvents(held, userId, profile)) flush();
  changes.screenReplaced(markStarts);
}
