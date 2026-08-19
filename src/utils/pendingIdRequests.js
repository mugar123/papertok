/**
 * Bookkeeping for "fetch these ids once, and only once".
 *
 * The failure this exists to prevent: marking an id as asked-for *before* its
 * response arrives. A request that is then abandoned — the read failed, the tab
 * changed, the page went away — leaves the id looking answered, and the row it
 * belongs to keeps its fallback title ("Untitled paper") for the life of the
 * page with no way to ask again.
 *
 * So a claim is provisional and a settlement is final:
 *
 * - `claim(ids)` returns the ids nobody is fetching yet and holds them, so a
 *   re-render does not fire the same read twice.
 * - `fulfill(ids)` is called **only when a response actually lands**. The batch
 *   is authoritative: an id with no record in it has no title to find, and
 *   re-asking on every render would burn reads on a known blank.
 * - `release(ids)` hands an abandoned or failed claim back to the pool, and
 *   reports how many ids became askable again — a caller holding this in a ref
 *   needs that to know whether a retry is worth scheduling, because mutating a
 *   ref renders nothing on its own.
 *
 * `maxAttempts` bounds the retry: an id whose read keeps failing settles rather
 * than looping forever against a denial that is not going to change.
 */
export function createPendingIdRequests({ maxAttempts = 3 } = {}) {
  const inFlight = new Set();
  const settled = new Set();
  const attempts = new Map();

  const claim = ids => {
    const fresh = [];
    ids.forEach(id => {
      if (inFlight.has(id) || settled.has(id) || fresh.includes(id)) return;
      inFlight.add(id);
      fresh.push(id);
    });
    return fresh;
  };

  const fulfill = ids => {
    ids.forEach(id => {
      inFlight.delete(id);
      attempts.delete(id);
      settled.add(id);
    });
  };

  const release = ids => {
    let askable = 0;
    ids.forEach(id => {
      if (!inFlight.delete(id)) return;
      const spent = (attempts.get(id) || 0) + 1;
      if (spent >= maxAttempts) {
        // Out of attempts: settle it rather than spin. The row keeps its
        // fallback title, which is the honest thing to show for a title this
        // page could not read.
        attempts.delete(id);
        settled.add(id);
        return;
      }
      attempts.set(id, spent);
      askable += 1;
    });
    return askable;
  };

  return {
    claim,
    fulfill,
    release,
    isSettled: id => settled.has(id),
    isInFlight: id => inFlight.has(id),
  };
}

/**
 * One round of "get the records for the ids that still need them".
 *
 * Never rejects: a caller in an effect wants the outcome, not an unhandled
 * rejection. `retryable` is true only when the failure left ids askable again,
 * which is the caller's cue to schedule the render that re-runs the effect.
 */
export async function requestMissingRecords({ ids, requests, fetchRecords }) {
  const missing = requests.claim(ids);
  if (missing.length === 0) return { records: [], missing, retryable: false, error: null };
  try {
    const records = await fetchRecords(missing);
    // The response landed: now, and only now, do these ids count as asked-for.
    requests.fulfill(missing);
    return { records, missing, retryable: false, error: null };
  } catch (error) {
    return { records: [], missing, retryable: requests.release(missing) > 0, error };
  }
}
