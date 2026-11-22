import type { LedgerStorage, LedgerTransaction } from './ledger-storage.ts';

type ReactivationConsent = { email: string; token: string };
type SubscriptionTransaction = LedgerTransaction & Pick<DurableObjectTransaction, 'getAlarm' | 'setAlarm' | 'deleteAlarm'>;

/**
 * What one reader's object holds: the digest subscription, or `null` once it is
 * deleted, and a version that every write raises. Version 0 means the object
 * has never been written. `migratable` is true until the object has been
 * written or marked as closed: only then may the KV record of a Worker from
 * before the object move in (see `EMAIL_SUBSCRIPTION_SOURCE`). `cancelledAt`
 * is the version the last cancellation reached (0 for none): a `mark` with
 * `migratable: false`, or a `write` that deletes the subscription. A KV record
 * written before it is a copy of a cancelled subscription.
 * `token` is the unsubscribe token the last `mark` with `migratable: true`
 * reopened the object for, present only while nothing has raised the version
 * since. A subscription keeps one token for all its emails, so a link from any
 * of them matches it; an unsubscribe link with another token belongs to an
 * earlier subscription a cancellation ended, whatever a stale KV read still
 * returns (ENG-193).
 * `cleanup` lists the deleted records whose KV keys the Worker has not
 * confirmed deleting (see `CleanupEntry`); a `read`, a deleting `write`, a
 * refused `write` and a `mark` that deleted a record return it, and only while
 * it is not empty.
 * `reactivation` binds reminder consent to one subscription and email address.
 * Grants and withdrawals advance `consentRevision` independently of the
 * subscription version, so they invalidate pending consent and visit writes
 * without invalidating a weekly digest draft.
 */
export interface SubscriptionSlot<Record = unknown> { version: number; subscription: Record | null; migratable: boolean; cancelledAt?: number; token?: string; cleanup?: CleanupEntry[]; reactivation?: ReactivationConsent; consentRevision?: number }
export interface SubscriptionStorePayload { action?: unknown; expectedVersion?: unknown; expectedConsentRevision?: unknown; subscription?: unknown; migratable?: unknown; token?: unknown; ack?: unknown; email?: unknown; indexes?: unknown }
/** What the object needs besides its storage: the KV namespace its `index` action writes, and the gate that holds other requests meanwhile. */
type SubscriptionState = { storage: LedgerStorage<SubscriptionTransaction>; blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> };
type IndexStore = { put(key: string, value: string): Promise<unknown> };
/**
 * One record the object deleted, by the version that step reached (`at`): its
 * delivery state id and unsubscribe token, which name the KV keys it leaves
 * (its delivery state and link index). Both are pseudonymous identifiers tied
 * to the reader's uid, kept only so the Worker can delete those keys: the
 * answer to the step can be lost after it lands, and the record that named
 * them is gone. The token here never cancels anything. A `write` that deletes
 * the subscription adds an entry, and so does a `mark` over a record the object
 * holds (a phase 1 Worker after a rollback, or during the switch); a mark over
 * an object that holds none, as for every reader phase 2 never moved, adds
 * none, since that reader's keys are in their KV record. An entry goes once a
 * `read` acknowledges its `at` (`ack`), after the Worker deleted its keys.
 */
export interface CleanupEntry { at: number; stateId?: string; token?: string }

const VERSION_KEY = 'version';
const SUBSCRIPTION_KEY = 'subscription';
const CLOSED_KEY = 'closed';
const CANCELLED_AT_KEY = 'cancelledAt';
const TOKEN_KEY = 'token';
const CLEANUP_KEY = 'cleanup';
const REACTIVATION_KEY = 'reactivation';
const CONSENT_REVISION_KEY = 'consentRevision';
const LAST_VISIT_KEY = 'lastVisitAt';
/**
 * The two KV keys that point at a reader's subscription: the one the schedule
 * lists, which in phase 1 holds the record itself for a reader whose record is
 * in KV, and the unsubscribe link's.
 */
export const SUBSCRIPTION_PREFIX = 'notification:subscription:';
export const UNSUBSCRIBE_PREFIX = 'notification:unsubscribe:';
const HOUR_MS = 60 * 60 * 1000;
const VISIT_RETENTION_MS = 30 * 24 * HOUR_MS;

async function clearReactivation(transaction: SubscriptionTransaction, nextRevision: number) {
  await transaction.delete(REACTIVATION_KEY);
  await transaction.delete(LAST_VISIT_KEY);
  await transaction.deleteAlarm();
  await transaction.put(CONSENT_REVISION_KEY, nextRevision);
}

/**
 * The last visit while it is under 30 days old. An older one is deleted here
 * and treated as absent, and a live one gets its expiry alarm back if it has
 * none, so a failed alarm cannot keep the visit: every access to the object,
 * the schedule's read of each subscriber included, expires or re-arms it.
 */
async function liveVisit(transaction: SubscriptionTransaction) {
  const lastVisit = await transaction.get<number>(LAST_VISIT_KEY);
  if (lastVisit === undefined) return undefined;
  const expiresAt = lastVisit + VISIT_RETENTION_MS;
  if (expiresAt <= Date.now()) {
    await transaction.delete(LAST_VISIT_KEY);
    return undefined;
  }
  if ((await transaction.getAlarm()) !== expiresAt) await transaction.setAlarm(expiresAt);
  return lastVisit;
}

// A string field of a subscription record the object holds.
function recordField(record: unknown, field: 'unsubscribeToken' | 'stateId' | 'email' | 'uid') {
  if (typeof record !== 'object' || record === null) return undefined;
  const value: unknown = Reflect.get(record, field);
  return typeof value === 'string' && value ? value : undefined;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * One reader's digest subscription, one object per Firebase uid (ENG-163).
 * KV keeps the last write and a location can read a copy up to a minute old, so
 * a sync, a save, an unsubscribe and the digest's send check could each act on
 * a different record. Here every read sees the last write, and a write lands
 * only on the version it was computed from: a writer that lost the race gets
 * the current slot back and computes again.
 *
 * While KV is still the record (phase 1 of the deploy), a Worker marks here
 * every unsubscribe, deletion and re-subscription it makes: `mark` with
 * `migratable: false` drops the subscription and closes the object to the KV
 * record, `migratable: true` reopens it. Unlike KV, the mark is seen by every
 * later read, so a stale KV copy of a cancelled reader is never moved in. A
 * mark with `expectedVersion` lands only on that version, so a save computed
 * before a cancellation cannot reopen the object the cancellation closed.
 * A reopening mark also names the subscription's unsubscribe token, which the
 * object keeps with the version that mark reached; a mark from a Worker that
 * names none, or any later write, leaves the object without a current token.
 * A closing mark that names a token is an unsubscribe link's: it lands only
 * while the object holds that token or none, so a save that reopened the
 * object for another subscription after the link was checked is not cancelled.
 * Once a write raised the version past the reopening mark, the token that
 * counts is the one of the subscription the object holds, if any.
 *
 * `index` writes the KV indexes of the subscription the object holds
 * (`schedule`: the key the schedule lists; `link`: the unsubscribe link's),
 * from inside the object, and only while it still holds that subscription at
 * `expectedVersion`. The object builds both from its own record, so the
 * caller names no key. No other request reaches the object until those puts
 * have landed (`blockConcurrencyWhile`), so every later cancellation or save,
 * and the KV write each makes after its own step here, comes after them. A
 * Worker that wrote those keys itself after its `write` could land them after
 * a later unsubscribe and re-subscribe, over the record a phase 1 save keeps
 * at the schedule key (ENG-215).
 */
export class EmailSubscriptionStore {
  declare state: SubscriptionState;
  declare indexes: IndexStore | undefined;

  constructor(state: SubscriptionState, env?: { NOTIFICATION_STORE?: IndexStore }) {
    this.state = state;
    this.indexes = env?.NOTIFICATION_STORE;
  }

  /** The `index` action: see the class comment. */
  private async writeIndexes(payload: SubscriptionStorePayload) {
    const wanted = payload.indexes;
    const indexes = this.indexes;
    if (
      !Number.isInteger(payload.expectedVersion) || typeof payload.token !== 'string' || !payload.token
      || !Array.isArray(wanted) || !wanted.length || !wanted.every(name => name === 'schedule' || name === 'link')
    ) {
      return json({ code: 'INVALID_REQUEST' }, 400);
    }
    if (!indexes) return json({ code: 'NOT_CONFIGURED' }, 503);
    return this.state.blockConcurrencyWhile(async () => {
      const slot = await this.state.storage.transaction(async transaction => ({
        version: Number(await transaction.get<number>(VERSION_KEY)) || 0,
        subscription: (await transaction.get(SUBSCRIPTION_KEY)) ?? null,
        migratable: (await transaction.get(CLOSED_KEY)) !== true,
        cancelledAt: Number(await transaction.get<number>(CANCELLED_AT_KEY)) || 0,
      }));
      const uid = recordField(slot.subscription, 'uid');
      if (payload.expectedVersion !== slot.version || !uid || recordField(slot.subscription, 'unsubscribeToken') !== payload.token) return json(slot, 409);
      try {
        await Promise.all([
          wanted.includes('schedule') ? indexes.put(`${SUBSCRIPTION_PREFIX}${uid}`, JSON.stringify({ uid })) : null,
          wanted.includes('link') ? indexes.put(`${UNSUBSCRIBE_PREFIX}${payload.token}`, uid) : null,
        ]);
      } catch {
        // The caller answers a retryable failure; a later request puts them again.
        return json({ code: 'INDEX_WRITE_FAILED' }, 503);
      }
      return json(slot);
    });
  }

  async alarm() {
    await this.state.storage.transaction(async transaction => { await liveVisit(transaction); });
  }

  async fetch(request: Request) {
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const payload = await request.json<SubscriptionStorePayload>().catch(() => null);
    if (payload?.action === 'index') return this.writeIndexes(payload);
    const write = payload?.action === 'write';
    const mark = payload?.action === 'mark';
    const optIn = payload?.action === 'reactivation-on';
    const optOut = payload?.action === 'reactivation-off';
    const visit = payload?.action === 'visit';
    const record = payload?.subscription;
    if (
      !payload
      || (!write && !mark && !optIn && !optOut && !visit && payload.action !== 'read')
      || ((optIn || visit) && (!Number.isInteger(payload.expectedVersion)
        || !Number.isInteger(payload.expectedConsentRevision)
        || typeof payload.email !== 'string' || !payload.email
        || typeof payload.token !== 'string' || !payload.token))
      || (mark && (typeof payload.migratable !== 'boolean'
        || (payload.token !== undefined && typeof payload.token !== 'string')
        || (payload.expectedVersion !== undefined && !Number.isInteger(payload.expectedVersion))))
      || (write && (
        !Number.isInteger(payload.expectedVersion)
        || (record !== null && (typeof record !== 'object' || Array.isArray(record)))
      ))
      // The Worker acknowledges only with a read, by versions: another shape is a Worker bug, so it fails loudly instead of being ignored.
      || (payload.ack !== undefined && (payload.action !== 'read' || !Array.isArray(payload.ack) || !payload.ack.every(Number.isInteger)))
    ) {
      return json({ code: 'INVALID_REQUEST' }, 400);
    }

    const outcome = await this.state.storage.transaction(async (transaction) => {
      const lastVisit = await liveVisit(transaction);
      const version = Number(await transaction.get<number>(VERSION_KEY)) || 0;
      const subscription = (await transaction.get(SUBSCRIPTION_KEY)) ?? null;
      const migratable = (await transaction.get(CLOSED_KEY)) !== true;
      const cancelledAt = Number(await transaction.get<number>(CANCELLED_AT_KEY)) || 0;
      const issued = await transaction.get<{ token?: unknown; version?: unknown }>(TOKEN_KEY);
      const token = issued?.version === version && typeof issued.token === 'string' ? issued.token : undefined;
      const reactivation = await transaction.get<ReactivationConsent>(REACTIVATION_KEY);
      const consentRevision = (await transaction.get<number>(CONSENT_REVISION_KEY)) ?? 0;
      if (optIn || optOut || visit) {
        const slot = { version, subscription: null, migratable };
        if (optOut) {
          await clearReactivation(transaction, consentRevision + 1);
          return { status: 200, slot: { ...slot, consentRevision: consentRevision + 1 } };
        }
        if (payload.expectedVersion !== version || payload.expectedConsentRevision !== consentRevision || (!migratable && !subscription)) {
          return { status: 409, slot };
        }
        const matches = reactivation?.email === payload.email && reactivation?.token === payload.token;
        if (optIn) {
          if (matches) {
            await transaction.put(CONSENT_REVISION_KEY, consentRevision + 1);
          } else {
            await clearReactivation(transaction, consentRevision + 1);
            await transaction.put(REACTIVATION_KEY, { email: payload.email, token: payload.token });
          }
          return { status: 200, slot: { ...slot, consentRevision: consentRevision + 1 } };
        }
        if (!matches) return { status: 409, slot };
        if (visit && matches) {
          const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
          if (lastVisit === undefined || lastVisit < hour) {
            await transaction.put(LAST_VISIT_KEY, hour);
            await transaction.setAlarm(hour + VISIT_RETENTION_MS);
          }
        }
        return { status: 200, slot };
      }
      const pending = async () => (await transaction.get<CleanupEntry[]>(CLEANUP_KEY)) ?? [];
      // Appends an entry for the record this step deletes, at the version it
      // reaches: once the record is gone, only the entry names its KV keys.
      const journal = async (at: number) => {
        const cleanup = await pending();
        const stateId = recordField(subscription, 'stateId');
        const deletedToken = recordField(subscription, 'unsubscribeToken');
        cleanup.push({ at, ...(stateId ? { stateId } : {}), ...(deletedToken ? { token: deletedToken } : {}) });
        await transaction.put(CLEANUP_KEY, cleanup);
        return cleanup;
      };
      if (!write && !mark) {
        let cleanup = await pending();
        // An acknowledgement removes exactly the entries it names: one added
        // since the Worker read the list stays for a later request.
        const acknowledged = new Set(Array.isArray(payload.ack) ? payload.ack : []);
        if (cleanup.some(entry => acknowledged.has(entry.at))) {
          cleanup = cleanup.filter(entry => !acknowledged.has(entry.at));
          if (cleanup.length) await transaction.put(CLEANUP_KEY, cleanup);
          else await transaction.delete(CLEANUP_KEY);
        }
        return { status: 200, slot: { version, subscription, migratable, cancelledAt, token, reactivation, consentRevision, ...(cleanup.length ? { cleanup } : {}) } };
      }
      if (mark) {
        // The subscription a closing mark would cancel: the one the last
        // reopening mark named, or the record a later write left.
        const current = token ?? recordField(subscription, 'unsubscribeToken');
        if (
          (payload.expectedVersion !== undefined && payload.expectedVersion !== version)
          // A cancellation for one link's subscription, after a save subscribed
          // the reader again with another one.
          || (!payload.migratable && payload.token !== undefined && current !== undefined && current !== payload.token)
        ) {
          return { status: 409, slot: { version, subscription, migratable, cancelledAt, token } };
        }
        const next = version + 1;
        const reopenedFor = payload.migratable && typeof payload.token === 'string' ? payload.token : undefined;
        if (!payload.migratable || (reactivation && (reactivation.token !== reopenedFor || reactivation.email !== payload.email))) {
          await clearReactivation(transaction, consentRevision + 1);
        }
        await transaction.put(VERSION_KEY, next);
        await transaction.put(CLOSED_KEY, !payload.migratable);
        if (!payload.migratable) await transaction.put(CANCELLED_AT_KEY, next);
        if (reopenedFor) await transaction.put(TOKEN_KEY, { token: reopenedFor, version: next });
        else await transaction.delete(TOKEN_KEY);
        await transaction.delete(SUBSCRIPTION_KEY);
        // A record the object held, which a phase 1 Worker reaches after a
        // rollback, is journaled as a deleting write's is. A mark over an
        // object that holds none reads no journal and answers without it.
        const cleanup = subscription ? await journal(next) : [];
        return { status: 200, slot: { version: next, subscription: null, migratable: Boolean(payload.migratable), cancelledAt: payload.migratable ? cancelledAt : next, token: reopenedFor, ...(cleanup.length ? { cleanup } : {}) } };
      }
      if (payload.expectedVersion !== version) {
        // A refused writer may decide from this slot to answer success or to
        // delete the schedule key, so it lists the journal too, with the
        // entry of a cancellation that won.
        const cleanup = await pending();
        return { status: 409, slot: { version, subscription, migratable, cancelledAt, token, reactivation, consentRevision, ...(cleanup.length ? { cleanup } : {}) } };
      }
      const next = version + 1;
      const keepsConsent = reactivation?.email === recordField(record, 'email')
        && reactivation?.token === recordField(record, 'unsubscribeToken');
      if (record === null || (reactivation && !keepsConsent)) {
        await clearReactivation(transaction, consentRevision + 1);
      }
      await transaction.put(VERSION_KEY, next);
      await transaction.put(CLOSED_KEY, true);
      // The record carries its own token from here on; a reopening mark's copy
      // would only outlive an unsubscribe or an account deletion.
      await transaction.delete(TOKEN_KEY);
      if (record !== null) {
        await transaction.put(SUBSCRIPTION_KEY, record);
        return { status: 200, slot: { version: next, subscription: record, migratable: false, cancelledAt, reactivation: keepsConsent ? reactivation : undefined, consentRevision: reactivation && !keepsConsent ? consentRevision + 1 : consentRevision } };
      }
      // A cancellation where the object is the record (phase 2): a KV copy
      // from before it, which a phase 1 Worker may still read, is cancelled too.
      await transaction.delete(SUBSCRIPTION_KEY);
      await transaction.put(CANCELLED_AT_KEY, next);
      const cleanup = subscription ? await journal(next) : await pending();
      return { status: 200, slot: { version: next, subscription: null, migratable: false, cancelledAt: next, ...(cleanup.length ? { cleanup } : {}) } };
    });
    return json(outcome.slot, outcome.status);
  }
}
