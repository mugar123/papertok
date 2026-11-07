export type DrawOutcome = 'drawn' | 'failed' | 'cancelled';

/**
 * Counts the page draws of one PDF to decide when it cannot be shown here.
 * Several pages start drawing together, so one page failing says nothing while
 * another is still drawing: the PDF is handed off only once a draw has failed,
 * none has been drawn and none is still in flight.
 */
export function createPageDraws() {
  let inFlight = 0;
  let drawn = false;
  let failed = false;
  return {
    start() {
      inFlight += 1;
    },
    /** Records how a started draw ended; true when the PDF should be handed off. */
    settle(outcome: DrawOutcome) {
      inFlight -= 1;
      if (outcome === 'drawn') drawn = true;
      if (outcome === 'failed') failed = true;
      return failed && !drawn && inFlight === 0;
    },
  };
}
