/**
 * Is the public copy of a list behind the private one?
 *
 * Two stamps on `users/{uid}/lists/{listId}` answer it, and they are written
 * by different machines on purpose:
 *
 *  - `updatedAt` — the client, on every edit that changes what a public copy
 *    would contain (membership, name).
 *  - `publicSyncedAt` — the Worker, inside the same commit that writes the
 *    public document (F11/F12). It cannot claim a sync that did not happen.
 *
 * `updatedAt` newer than `publicSyncedAt` therefore means exactly one thing:
 * an edit landed and its sync did not. That is the whole recovery mechanism
 * behind removing the manual Update button — a sync lost to a closed tab, a
 * dead connection or a spent daily quota is not lost, it is *pending*, and the
 * next time the owner opens the list it is rebuilt without being asked.
 *
 * The two stamps arrive in different shapes (Firestore `Timestamp` from a
 * server read, a plain `Date` from the optimistic local patch, an ISO string
 * from older documents), so the comparison normalizes before it compares. A
 * value it cannot read counts as zero — never as "in the future", which would
 * mute the indicator this exists to raise.
 */

/** Milliseconds since the epoch, from whatever shape the field arrived in. */
export function toEpochMillis(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  }
  if (typeof value.toMillis === 'function') {
    try {
      const millis = value.toMillis();
      return Number.isFinite(millis) ? millis : 0;
    } catch {
      return 0;
    }
  }
  if (typeof value.seconds === 'number') {
    const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
    return value.seconds * 1000 + Math.floor(nanos / 1e6);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * True when this list has a public copy and that copy is stale.
 *
 * An unpublished list is never stale — it has nothing to be stale against —
 * and neither is a list that has never been edited since the field existed:
 * with no `updatedAt` there is no evidence of an edit, and guessing "dirty"
 * there would re-publish every list in the account on first open.
 */
export function listNeedsPublicSync(list) {
  if (!list?.publicShareId) return false;
  const editedAt = toEpochMillis(list.updatedAt);
  if (!editedAt) return false;
  return editedAt > toEpochMillis(list.publicSyncedAt);
}

/**
 * The queue key. Scoped by uid as well as list id: the sync engine is a module
 * singleton and outlives a sign-out, and two accounts on one device must never
 * coalesce onto the same job.
 */
export function publicListSyncKey(uid, listId) {
  return `${uid}:${listId}`;
}
