/**
 * The Worker, for a test that renders the app: it replaces the global `fetch`
 * the app's own Worker client calls, so the app's real request and error code
 * run. A test names the routes it controls with `hold`; a request to one
 * waits until the test answers it (it ignores the app's deadline signal), which
 * lets a test decide what the reader does while a load is still in flight. Any
 * other address is unreachable.
 */
const WORKER_ORIGIN = 'https://api.papertok.app';

interface HeldRoute {
  waiting: Array<(response: Response) => void>;
  verdict: (() => Response) | null;
  arrived: Array<() => void>;
  count: number;
}

export function stubWorker() {
  const realFetch = globalThis.fetch;
  const routes = new Map<string, HeldRoute>();
  const open = new Set<(reason: unknown) => void>();

  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = url.origin === WORKER_ORIGIN ? routes.get(url.pathname) : undefined;
    if (!route) return Promise.reject(new TypeError(`No stub for ${url.origin}${url.pathname}`));
    route.count += 1;
    route.arrived.splice(0).forEach(notify => notify());
    if (route.verdict) return Promise.resolve(route.verdict());
    return new Promise<Response>((resolve, reject) => {
      open.add(reject);
      route.waiting.push((response) => { open.delete(reject); resolve(response); });
    });
  };

  return {
    /**
     * Holds the requests to `path`. `refuse` answers the ones waiting and every
     * later one with that status and error code, as a Worker that is down does.
     */
    hold(path: string) {
      const route: HeldRoute = { waiting: [], verdict: null, arrived: [], count: 0 };
      routes.set(path, route);
      return {
        /** Resolves once a request to the route has arrived. */
        async requested(timeoutMs = 15_000) {
          if (route.count > 0) return;
          const arrived = new Promise<void>(notify => { route.arrived.push(notify); });
          const late = new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error(`No request to ${path} within ${timeoutMs} ms`)); }, timeoutMs).unref(); });
          await Promise.race([arrived, late]);
        },
        refuse(status: number, code: string) {
          const verdict = () => Response.json({ code }, { status });
          route.verdict = verdict;
          route.waiting.splice(0).forEach(settle => { settle(verdict()); });
        },
        /** Answers the requests waiting and every later one with `body`, as a Worker that is up does. */
        answer(body: unknown) {
          const verdict = () => Response.json(body);
          route.verdict = verdict;
          route.waiting.splice(0).forEach(settle => { settle(verdict()); });
        },
        /** Holds the requests that arrive from now on again, until the next answer or refusal. */
        wait() {
          route.verdict = null;
        },
      };
    },
    /** Ends the requests nobody answered, as a closed tab does, and restores `fetch`. */
    stop() {
      for (const reject of open) reject(new DOMException('The page closed.', 'AbortError'));
      open.clear();
      globalThis.fetch = realFetch;
    },
  };
}
