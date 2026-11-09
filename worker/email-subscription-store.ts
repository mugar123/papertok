import type { LedgerStorage } from './ledger-storage.ts';

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
 * `cleanup` lists the records a `write` deleted whose KV keys the Worker has
 * not confirmed deleting (see `CleanupEntry`); a `read` and a deleting `write`
 * return it, and only while it is not empty.
 */
export interface SubscriptionSlot<Record = unknown> { version: number; subscription: Record | null; migratable: boolean; cancelledAt?: number; token?: string; cleanup?: CleanupEntry[] }
export interface SubscriptionStorePayload { action?: unknown; expectedVersion?: unknown; subscription?: unknown; migratable?: unknown; token?: unknown; ack?: unknown }
/**
 * One record a `write` deleted, by the version that write reached (`at`): its
 * delivery state id and unsubscribe token, which name the KV keys it leaves
 * (its delivery state and link index). Both are pseudonymous identifiers of the
 * reader's cancelled subscription, kept only so the Worker can delete those
 * keys: the answer to the write can be lost after it lands, and the record
 * that named them is gone. The token here never cancels anything. An entry
 * goes once a `read` acknowledges its `at` (`ack`), after the Worker deleted
 * its keys. A `mark` adds none: in phase 1 the KV record is deleted by the
 * request that closes the object.
 */
export interface CleanupEntry { at: number; stateId?: string; token?: string }

const VERSION_KEY = 'version';
const SUBSCRIPTION_KEY = 'subscription';
const CLOSED_KEY = 'closed';
const CANCELLED_AT_KEY = 'cancelledAt';
const TOKEN_KEY = 'token';
const CLEANUP_KEY = 'cleanup';

// A string field of a subscription record the object holds.
function recordField(record: unknown, field: 'unsubscribeToken' | 'stateId') {
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
 */
export class EmailSubscriptionStore {
  declare state: { storage: LedgerStorage };

  constructor(state: { storage: LedgerStorage }) {
    this.state = state;
  }

  async fetch(request: Request) {
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const payload = await request.json<SubscriptionStorePayload>().catch(() => null);
    const write = payload?.action === 'write';
    const mark = payload?.action === 'mark';
    const record = payload?.subscription;
    if (
      !payload
      || (!write && !mark && payload.action !== 'read')
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
      const version = Number(await transaction.get<number>(VERSION_KEY)) || 0;
      const subscription = (await transaction.get(SUBSCRIPTION_KEY)) ?? null;
      const migratable = (await transaction.get(CLOSED_KEY)) !== true;
      const cancelledAt = Number(await transaction.get<number>(CANCELLED_AT_KEY)) || 0;
      const issued = await transaction.get<{ token?: unknown; version?: unknown }>(TOKEN_KEY);
      const token = issued?.version === version && typeof issued.token === 'string' ? issued.token : undefined;
      const pending = async () => (await transaction.get<CleanupEntry[]>(CLEANUP_KEY)) ?? [];
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
        return { status: 200, slot: { version, subscription, migratable, cancelledAt, token, ...(cleanup.length ? { cleanup } : {}) } };
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
        await transaction.put(VERSION_KEY, next);
        await transaction.put(CLOSED_KEY, !payload.migratable);
        if (!payload.migratable) await transaction.put(CANCELLED_AT_KEY, next);
        if (reopenedFor) await transaction.put(TOKEN_KEY, { token: reopenedFor, version: next });
        else await transaction.delete(TOKEN_KEY);
        await transaction.delete(SUBSCRIPTION_KEY);
        return { status: 200, slot: { version: next, subscription: null, migratable: Boolean(payload.migratable), cancelledAt: payload.migratable ? cancelledAt : next, token: reopenedFor } };
      }
      if (payload.expectedVersion !== version) return { status: 409, slot: { version, subscription, migratable, cancelledAt, token } };
      const next = version + 1;
      await transaction.put(VERSION_KEY, next);
      await transaction.put(CLOSED_KEY, true);
      // The record carries its own token from here on; a reopening mark's copy
      // would only outlive an unsubscribe or an account deletion.
      await transaction.delete(TOKEN_KEY);
      if (record !== null) {
        await transaction.put(SUBSCRIPTION_KEY, record);
        return { status: 200, slot: { version: next, subscription: record, migratable: false, cancelledAt } };
      }
      // A cancellation where the object is the record (phase 2): a KV copy
      // from before it, which a phase 1 Worker may still read, is cancelled too.
      await transaction.delete(SUBSCRIPTION_KEY);
      await transaction.put(CANCELLED_AT_KEY, next);
      // Once the record is gone, only this entry names its KV keys.
      const cleanup = await pending();
      if (subscription) {
        const stateId = recordField(subscription, 'stateId');
        const deletedToken = recordField(subscription, 'unsubscribeToken');
        cleanup.push({ at: next, ...(stateId ? { stateId } : {}), ...(deletedToken ? { token: deletedToken } : {}) });
        await transaction.put(CLEANUP_KEY, cleanup);
      }
      return { status: 200, slot: { version: next, subscription: null, migratable: false, cancelledAt: next, ...(cleanup.length ? { cleanup } : {}) } };
    });
    return json(outcome.slot, outcome.status);
  }
}
