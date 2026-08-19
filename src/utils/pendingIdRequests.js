/**
 * Bookkeeping for "fetch these ids once, and only once — but only believe
 * answers that deserve it".
 *
 * Two failure shapes produced pages of "Untitled paper" rows:
 *
 * 1. Marking an id as asked-for *before* its response arrived. An abandoned
 *    request left the id looking answered, permanently blank, no retry.
 * 2. Believing a non-authoritative answer. With the backend unreachable,
 *    Firestore's `getDocs` does not reject — it resolves from the local cache,
 *    and an empty cache resolves to an empty *success*. Settling ids on that
 *    answer latched a connectivity blip into "these papers have no titles"
 *    for the life of the page. A permission blip (rules mid-deploy) burning a
 *    small fixed retry budget in under two seconds stranded the page the same
 *    way.
 *
 * So the rules here are:
 *
 * - `claim(ids)` holds ids while a request is in flight, so a re-render does
 *   not fire the same read twice.
 * - `fulfill(ids)` settles ids for good. Only two things earn it: a record
 *   actually in hand, or a server-confirmed absence.
 * - `release(ids)` hands ids back to the pool and counts the attempt. Nothing
 *   is ever settled by failure — instead `attemptsFor` reports how many times
 *   an id has come back unanswered, and the caller stretches the delay
 *   between retries. A read that keeps failing ends up costing one cheap
 *   request per backoff ceiling instead of a page stuck on fallbacks, and it
 *   heals itself the moment the backend answers again.
 */
export function createPendingIdRequests() {
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
      attempts.set(id, (attempts.get(id) || 0) + 1);
      askable += 1;
    });
    return askable;
  };

  const attemptsFor = ids => ids.reduce(
    (most, id) => Math.max(most, attempts.get(id) || 0),
    0,
  );

  return {
    claim,
    fulfill,
    release,
    attemptsFor,
    isSettled: id => settled.has(id),
    isInFlight: id => inFlight.has(id),
  };
}

/**
 * One round of "get the records for the ids that still need them".
 *
 * `fetchRecords` may resolve to a plain array (treated as authoritative) or to
 * `{ records, authoritative }`. Records in hand always settle their ids —
 * cached data is still data. Ids that came back with nothing settle only when
 * the answer was authoritative; otherwise they are released and `retryable`
 * tells the caller to schedule another round, with `attempt` sizing the
 * backoff. Never rejects: a caller in an effect wants the outcome, not an
 * unhandled rejection.
 */
export async function requestMissingRecords({ ids, requests, fetchRecords }) {
  const missing = requests.claim(ids);
  if (missing.length === 0) {
    return { records: [], missing, retryable: false, attempt: 0, error: null };
  }
  try {
    const result = await fetchRecords(missing);
    const { records, authoritative } = Array.isArray(result)
      ? { records: result, authoritative: true }
      : { records: result.records, authoritative: !result.fromCache && result.authoritative !== false };
    const answered = new Set(records.map(record => record.id));
    requests.fulfill(missing.filter(id => answered.has(id)));
    const unanswered = missing.filter(id => !answered.has(id));
    if (authoritative) {
      // The server itself said these ids have no records. That absence is
      // final: re-asking on every render would burn reads on a known blank.
      requests.fulfill(unanswered);
      return { records, missing, retryable: false, attempt: 0, error: null };
    }
    const askable = requests.release(unanswered);
    return {
      records,
      missing,
      retryable: askable > 0,
      attempt: requests.attemptsFor(unanswered),
      error: null,
    };
  } catch (error) {
    const askable = requests.release(missing);
    return {
      records: [],
      missing,
      retryable: askable > 0,
      attempt: requests.attemptsFor(missing),
      error,
    };
  }
}
