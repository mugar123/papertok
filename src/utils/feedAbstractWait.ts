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
