/**
 * Firestore wiring for the interaction profile aggregate.
 *
 * Kept apart from the pure logic in utils/interactionProfile* so those modules
 * stay unit-testable under `node --test` without the Firebase SDK.
 *
 * The browser writes this document directly, like every other write in the app.
 * A Worker round trip would add latency to every swipe and needs a secret this
 * document does not justify, and the security rules can already bound its shape
 * and size completely. What makes direct writes safe is that the document is
 * derived: the interaction subcollection stays the source of truth, so a
 * corrupt aggregate self-heals through the same bounded rebuild that a missing
 * one triggers.
 */
import {
  collection,
  doc,
  documentId,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  startAfter,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import { serializeInteractionProfile } from '../utils/interactionProfile.js';

export const INTERACTION_PROFILE_COLLECTION = 'aggregates';
export const INTERACTION_PROFILE_DOC_ID = 'interactions';

// Writes are coalesced: a fast scroll produces a burst of skip and view-time
// events and the aggregate only has to be durable, not instantaneous. The
// in-memory profile is updated synchronously, so nothing the user sees waits.
const FLUSH_DELAY_MS = 4000;
const LIBRARY_BATCH_SIZE = 10;

const pendingFlushes = new Map();

/**
 * Development-only read counter.
 *
 * Firestore traffic rides a WebChannel, so the number of documents a page load
 * actually billed is not readable from the network panel. This records it at the
 * only layer that knows: expose `window.__papertokReads` in `npm run dev` and it
 * is stripped from production builds.
 */
function countReads(kind, count) {
  if (!import.meta.env?.DEV || count <= 0) return;
  const stats = (globalThis.__papertokReads ??= {
    aggregate: 0,
    interactions: 0,
    library: 0,
    driftCheck: 0,
    log: [],
    reset() {
      this.aggregate = 0;
      this.interactions = 0;
      this.library = 0;
      this.driftCheck = 0;
      this.log = [];
      return 'reset';
    },
    get interactionDataTotal() {
      return this.aggregate + this.interactions + this.driftCheck;
    },
  });
  stats[kind] += count;
  stats.log.push({ kind, count, at: new Date().toISOString() });
}

export function interactionProfileRef(userId) {
  return doc(db, 'users', userId, INTERACTION_PROFILE_COLLECTION, INTERACTION_PROFILE_DOC_ID);
}

export function interactionsRef(userId) {
  return collection(db, 'users', userId, 'interactions');
}

export function createInteractionProfileClient(userId) {
  return {
    userId,
    async readAggregate() {
      const snapshot = await getDoc(interactionProfileRef(userId));
      countReads('aggregate', 1);
      return { exists: snapshot.exists(), data: snapshot.exists() ? snapshot.data() : null };
    },
    async listInteractionPage({ pageSize, startAfterId }) {
      // Paginating by document id rather than by timestamp: timestamp is an
      // optional field and an orderBy on it would silently drop any document
      // that never received one.
      const constraints = [orderBy(documentId()), limit(pageSize)];
      if (startAfterId) constraints.splice(1, 0, startAfter(startAfterId));
      const snapshot = await getDocs(query(interactionsRef(userId), ...constraints));
      const documents = snapshot.docs.map(item => ({ id: item.id, data: item.data() }));
      countReads('interactions', documents.length);
      return { documents, hasMore: documents.length === pageSize };
    },
    /**
     * Counts the interaction documents without reading them. Firestore bills a
     * count aggregation per batch of index entries rather than per document, so
     * this is far cheaper than the scan it may avoid — but it is not free, which
     * is why the caller only asks for it occasionally rather than every load.
     */
    async countInteractions() {
      const snapshot = await getCountFromServer(interactionsRef(userId));
      const count = snapshot.data().count;
      const reads = Math.max(1, Math.ceil(count / 1000));
      countReads('driftCheck', reads);
      return { count, reads };
    },
    async writeAggregate(document) {
      await setDoc(interactionProfileRef(userId), document);
    },
  };
}

export async function writeInteractionProfile(userId, profile) {
  if (!userId || !profile) return;
  await setDoc(interactionProfileRef(userId), serializeInteractionProfile(profile));
}

export function scheduleInteractionProfileFlush(userId, profile) {
  if (!userId || !profile) return;
  const existing = pendingFlushes.get(userId);
  if (existing) clearTimeout(existing.timeoutId);

  const timeoutId = setTimeout(() => {
    pendingFlushes.delete(userId);
    writeInteractionProfile(userId, profile).catch((error) => {
      console.warn('Could not persist the interaction profile:', error);
    });
  }, FLUSH_DELAY_MS);

  pendingFlushes.set(userId, { timeoutId, profile });
}

export function flushInteractionProfileNow(userId) {
  const pending = userId ? pendingFlushes.get(userId) : null;
  if (!pending) return Promise.resolve();
  clearTimeout(pending.timeoutId);
  pendingFlushes.delete(userId);
  return writeInteractionProfile(userId, pending.profile).catch((error) => {
    console.warn('Could not persist the interaction profile:', error);
  });
}

export function flushAllInteractionProfiles() {
  return Promise.all([...pendingFlushes.keys()].map(flushInteractionProfileNow));
}

/**
 * Fetches the library records for a bounded list of paper ids.
 *
 * The reading library used to arrive as a side effect of scanning every
 * interaction document on feed load. It is now loaded on demand by the screens
 * that render it, from the ids the aggregate already holds, in batches the
 * `in` operator accepts.
 */
/**
 * Returns `{ records, fromCache }`, not a bare array, because the caller has
 * to know how much the answer is worth. With the backend unreachable,
 * `getDocs` does not reject — it resolves against the local cache, and this
 * app keeps Firestore's default in-memory cache, so on a fresh page that
 * answer is an empty success. Treating it as "these ids have no records"
 * is what turned a connectivity blip into a page of untitled rows.
 * `fromCache` is true if ANY batch was served locally: absence is only
 * trustworthy when every batch heard back from the server.
 */
export async function fetchLibraryRecords(userId, paperIds) {
  if (!userId || !paperIds?.length) return { records: [], fromCache: false };
  const batches = [];
  for (let index = 0; index < paperIds.length; index += LIBRARY_BATCH_SIZE) {
    batches.push(paperIds.slice(index, index + LIBRARY_BATCH_SIZE));
  }

  const results = await Promise.all(batches.map(async (batch) => {
    const snapshot = await getDocs(
      query(interactionsRef(userId), where(documentId(), 'in', batch)),
    );
    return {
      fromCache: snapshot.metadata.fromCache,
      records: snapshot.docs.map(item => ({ id: item.id, data: item.data() })),
    };
  }));
  const records = results.flatMap(result => result.records);
  countReads('library', records.length);
  return { records, fromCache: results.some(result => result.fromCache) };
}
