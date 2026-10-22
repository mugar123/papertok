import type { WorkerEnv } from '../env.ts';
import { RequestQuotaLedger } from '../request-quota-ledger.ts';

// The quota ledger Durable Object, one in-memory instance per period key, as
// the Worker's tests reach it through the binding. Test-only.

export function inMemoryQuotaLedger() {
  const objects = new Map<string, RequestQuotaLedger>();
  const calls: string[] = [];
  const binding = {
    idFromName: (name: string): unknown => name,
    get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => {
      const key = String(name);
      if (!objects.has(key)) {
        const values = new Map<string, unknown>();
        let alarm: number | null = null;
        objects.set(key, new RequestQuotaLedger({ storage: {
          transaction: callback => callback({
            get: <T>(item: string) => values.get(item) as T | undefined,
            put: (item: string, value: unknown) => { values.set(item, value); },
            delete: (item: string) => values.delete(item),
          }),
          getAlarm: async () => alarm,
          setAlarm: async (value: number | Date) => { alarm = Number(value); },
          deleteAll: async () => values.clear(),
        } as RequestQuotaLedger['state']['storage'] }));
      }
      return {
        fetch: async (url, init) => {
          calls.push(key);
          return objects.get(key)!.fetch(new Request(String(url), init));
        },
      };
    },
  } as WorkerEnv['REQUEST_QUOTA_LEDGER'];
  return { binding, calls };
}
