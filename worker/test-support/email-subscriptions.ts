import type { WorkerEnv } from '../env.ts';
import { EmailSubscriptionStore } from '../email-subscription-store.ts';

// The `EMAIL_SUBSCRIPTIONS` binding: one in-memory object per uid, its
// transactions run one after another as a Durable Object's are. Test-only.

export function inMemorySubscriptionStores() {
  const objects = new Map<string, {
    store: EmailSubscriptionStore;
    values: Map<string, unknown>;
    alarm: () => number | null;
    alarmWrites: () => number;
  }>();
  return {
    idFromName: (name: string): unknown => name,
    visitState: (uid: string) => {
      const object = objects.get(uid);
      return { lastVisit: object?.values.get('lastVisitAt'), alarm: object?.alarm() ?? null, alarmWrites: object?.alarmWrites() ?? 0 };
    },
    runAlarm: async (uid: string) => {
      await objects.get(uid)?.store.alarm();
    },
    get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => {
      const key = String(name);
      if (!objects.has(key)) {
        const values = new Map<string, unknown>();
        let alarm: number | null = null;
        let alarmWrites = 0;
        let queue: Promise<unknown> = Promise.resolve();
        const store = new EmailSubscriptionStore({ storage: {
          transaction: (callback) => {
            const run = queue.then(() => callback({
              get: <T>(item: string) => structuredClone(values.get(item)) as T | undefined,
              put: (item: string, value: unknown) => { values.set(item, structuredClone(value)); },
              delete: (item: string) => values.delete(item),
              setAlarm: async (at) => { alarm = Number(at); alarmWrites += 1; },
              deleteAlarm: async () => { alarm = null; },
            }));
            queue = run.catch(() => {});
            return run;
          },
        } });
        objects.set(key, { store, values, alarm: () => alarm, alarmWrites: () => alarmWrites });
      }
      return { fetch: async (url, init) => objects.get(key)!.store.fetch(new Request(String(url), init)) };
    },
  } as NonNullable<WorkerEnv['EMAIL_SUBSCRIPTIONS']> & {
    visitState(uid: string): { lastVisit: unknown; alarm: number | null; alarmWrites: number };
    runAlarm(uid: string): Promise<void>;
  };
}
