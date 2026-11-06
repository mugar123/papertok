import type { LedgerStorage } from './ledger-storage.ts';

/**
 * What one reader's object holds: the digest subscription, or `null` once it is
 * deleted, and a version that every write raises. Version 0 means the object
 * has never been written.
 */
export interface SubscriptionSlot<Record = unknown> { version: number; subscription: Record | null }
export interface SubscriptionStorePayload { action?: unknown; expectedVersion?: unknown; subscription?: unknown }

const VERSION_KEY = 'version';
const SUBSCRIPTION_KEY = 'subscription';

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
    const record = payload?.subscription;
    if (
      !payload
      || (!write && payload.action !== 'read')
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
      if (!write) return { status: 200, slot: { version, subscription } };
      if (payload.expectedVersion !== version) return { status: 409, slot: { version, subscription } };
      const next = version + 1;
      await transaction.put(VERSION_KEY, next);
      if (record === null) await transaction.delete(SUBSCRIPTION_KEY);
      else await transaction.put(SUBSCRIPTION_KEY, record);
      return { status: 200, slot: { version: next, subscription: record } };
    });
    return json(outcome.slot, outcome.status);
  }
}
