import { awaitWithinGate } from './feedCitationGate.ts';

// The slowest abstract source's own deadline: Europe PMC aborts at 7 s,
// OpenAlex enrichment at 6.5 s and recovery at 6 s.
export const ABSTRACT_WAIT_MS = 7_000;
const NONE: ReadonlySet<string> = new Set();

/** One entry per open wait: the shown cards whose abstract may still arrive. */
export type AbstractWaits = ReadonlyArray<ReadonlySet<string>>;

/** The shown cards that say their abstract is loading. */
export function abstractWaitIds(waits: AbstractWaits) {
  return new Set(waits.flatMap(ids => [...ids]));
}

/** What a card's status region can say about its abstract wait. */
export type AbstractAnnouncement = { readonly awaiting: boolean; readonly ended: string };

/**
 * A card's announcement after a render; `previous` is undefined on the first.
 * How a wait ended is said only on the card on screen, and is cleared when the
 * card leaves it, so returning does not repeat it: the abstract area shows the
 * result when the reader gets there. Returns `previous` itself when nothing
 * changed, so a component can update it during render.
 */
export function nextAbstractAnnouncement(
  previous: AbstractAnnouncement | undefined,
  { awaiting, hasText, visible }: { awaiting: boolean; hasText: boolean; visible: boolean },
): AbstractAnnouncement {
  if (!previous) return { awaiting, ended: '' };
  if (previous.awaiting !== awaiting) {
    return { awaiting, ended: !awaiting && visible ? (hasText ? 'Abstract loaded' : 'No abstract available') : '' };
  }
  return previous.ended && !visible ? { awaiting, ended: '' } : previous;
}

/** The region's words: only the card on screen speaks. */
export function abstractStatusText(announcement: AbstractAnnouncement, visible: boolean) {
  return !visible ? '' : announcement.awaiting ? 'Loading abstract' : announcement.ended;
}

/**
 * Opens a wait for shown cards that a running request can still fill. It
 * closes when `sources` settle or after ABSTRACT_WAIT_MS. The returned function
 * gives the cards that may still receive text: call it when a response lands,
 * before queueing its update, so text after the close cannot replace a
 * missing-abstract state the card already shows.
 */
export function openAbstractWait(
  setWaits: (update: (current: AbstractWaits) => AbstractWaits) => void,
  ids: ReadonlySet<string>,
  sources: Array<PromiseLike<unknown>>,
) {
  if (ids.size === 0) return () => NONE;
  let open = true;
  setWaits(current => [...current, ids]);
  void awaitWithinGate(sources, { maxWaitMs: ABSTRACT_WAIT_MS }).then(() => {
    open = false;
    setWaits(current => current.filter(wait => wait !== ids));
  });
  return () => (open ? ids : NONE);
}
