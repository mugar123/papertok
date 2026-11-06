import type { LedgerStorage } from './ledger-storage.ts';

/**
 * What one reader's object holds: the digest subscription, or `null` once it is
 * deleted, and a version that every write raises. Version 0 means the object
 * has never been written. `migratable` is true until the object has been
 * written or marked as closed: only then may the KV record of a Worker from
 * before the object move in (see `EMAIL_SUBSCRIPTION_SOURCE`).
 */
export interface SubscriptionSlot<Record = unknown> { version: number; subscription: Record | null; migratable: boolean }
export interface SubscriptionStorePayload { action?: unknown; expectedVersion?: unknown; subscription?: unknown; migratable?: unknown }

const VERSION_KEY = 'version';
const SUBSCRIPTION_KEY = 'subscription';
const CLOSED_KEY = 'closed';

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
        || (payload.expectedVersion !== undefined && !Number.isInteger(payload.expectedVersion))))
      || (write && (
        !Number.isInteger(payload.expectedVersion)
        || (record !== null && (typeof record !== 'object' || Array.isArray(record)))
      ))
    ) {
      return json({ code: 'INVALID_REQUEST' }, 400);
    }

    const outcome = await this.state.storage.transaction(async (transaction) => {
      const version = Number(await transaction.get<number>(VERSION_KEY)) || 0;
      const subscription = (await transaction.get(SUBSCRIPTION_KEY)) ?? null;
      const migratable = (await transaction.get(CLOSED_KEY)) !== true;
      if (!write && !mark) return { status: 200, slot: { version, subscription, migratable } };
      if (mark) {
        if (payload.expectedVersion !== undefined && payload.expectedVersion !== version) {
          return { status: 409, slot: { version, subscription, migratable } };
        }
        const next = version + 1;
        await transaction.put(VERSION_KEY, next);
        await transaction.put(CLOSED_KEY, !payload.migratable);
        await transaction.delete(SUBSCRIPTION_KEY);
        return { status: 200, slot: { version: next, subscription: null, migratable: Boolean(payload.migratable) } };
      }
      if (payload.expectedVersion !== version) return { status: 409, slot: { version, subscription, migratable } };
      const next = version + 1;
      await transaction.put(VERSION_KEY, next);
      await transaction.put(CLOSED_KEY, true);
      if (record === null) await transaction.delete(SUBSCRIPTION_KEY);
      else await transaction.put(SUBSCRIPTION_KEY, record);
      return { status: 200, slot: { version: next, subscription: record, migratable: false } };
    });
    return json(outcome.slot, outcome.status);
  }
}
