import type { WorkerEnv } from '../env.ts';
import { EmailSubscriptionStore } from '../email-subscription-store.ts';

// The `EMAIL_SUBSCRIPTIONS` binding: one in-memory object per uid, its
// transactions run one after another as a Durable Object's are. Test-only.

export function inMemorySubscriptionStores() {
  const objects = new Map<string, EmailSubscriptionStore>();
  return {
    idFromName: (name: string): unknown => name,
    get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => {
      const key = String(name);
      if (!objects.has(key)) {
        const values = new Map<string, unknown>();
        let queue: Promise<unknown> = Promise.resolve();
        objects.set(key, new EmailSubscriptionStore({ storage: {
          transaction: (callback) => {
            const run = queue.then(() => callback({
              get: <T>(item: string) => structuredClone(values.get(item)) as T | undefined,
              put: (item: string, value: unknown) => { values.set(item, structuredClone(value)); },
              delete: (item: string) => values.delete(item),
            }));
            queue = run.catch(() => {});
            return run;
          },
        } }));
      }
      return { fetch: async (url, init) => objects.get(key)!.fetch(new Request(String(url), init)) };
    },
  } as WorkerEnv['EMAIL_SUBSCRIPTIONS'];
}
