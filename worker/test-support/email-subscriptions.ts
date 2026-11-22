import type { WorkerEnv } from '../env.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EmailSubscriptionStore } from '../email-subscription-store.ts';

// The `EMAIL_SUBSCRIPTIONS` binding: one in-memory object per uid, its
// transactions run one after another as a Durable Object's are. Test-only.
// `kv` is the namespace the objects write their indexes to (the `index`
// action); without it that action answers as not configured.
// `blockConcurrencyWhile` holds every other request to the object until its
// callback has settled, the callback's own transactions excepted, as on
// Cloudflare. A request the object awaits outside it (a KV put) holds nobody.

export function inMemorySubscriptionStores(kv?: { put(key: string, value: string): Promise<unknown> }) {
  const objects = new Map<string, {
    store: EmailSubscriptionStore;
    values: Map<string, unknown>;
    alarm: () => number | null;
    alarmWrites: () => number;
    clearAlarm: () => void;
  }>();
  return {
    idFromName: (name: string): unknown => name,
    visitState: (uid: string) => {
      const object = objects.get(uid);
      return { lastVisit: object?.values.get('lastVisitAt'), alarm: object?.alarm() ?? null, alarmWrites: object?.alarmWrites() ?? 0 };
    },
    // As on Cloudflare, a firing alarm is no longer scheduled while it runs.
    runAlarm: async (uid: string) => {
      objects.get(uid)?.clearAlarm();
      await objects.get(uid)?.store.alarm();
    },
    // An alarm whose handler failed every retry: Cloudflare stops scheduling it.
    dropAlarm: (uid: string) => {
      objects.get(uid)?.clearAlarm();
    },
    get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => {
      const key = String(name);
      if (!objects.has(key)) {
        const values = new Map<string, unknown>();
        let alarm: number | null = null;
        let alarmWrites = 0;
        let queue: Promise<unknown> = Promise.resolve();
        const insideGate = new AsyncLocalStorage<boolean>();
        const next = <T>(task: () => Promise<T> | T) => {
          const run = queue.then(task);
          queue = run.catch(() => {});
          return run;
        };
        const store = new EmailSubscriptionStore({ storage: {
          transaction: (callback) => {
            const run = () => callback({
              get: <T>(item: string) => structuredClone(values.get(item)) as T | undefined,
              put: (item: string, value: unknown) => { values.set(item, structuredClone(value)); },
              delete: (item: string) => values.delete(item),
              getAlarm: async () => alarm,
              setAlarm: async (at) => { alarm = Number(at); alarmWrites += 1; },
              deleteAlarm: async () => { alarm = null; },
            });
            return insideGate.getStore() ? run() : next(run);
          },
        }, blockConcurrencyWhile: callback => next(() => insideGate.run(true, callback)) }, { NOTIFICATION_STORE: kv });
        objects.set(key, { store, values, alarm: () => alarm, alarmWrites: () => alarmWrites, clearAlarm: () => { alarm = null; } });
      }
      return { fetch: async (url, init) => objects.get(key)!.store.fetch(new Request(String(url), init)) };
    },
  } as NonNullable<WorkerEnv['EMAIL_SUBSCRIPTIONS']> & {
    visitState(uid: string): { lastVisit: unknown; alarm: number | null; alarmWrites: number };
    runAlarm(uid: string): Promise<void>;
    dropAlarm(uid: string): void;
  };
}
