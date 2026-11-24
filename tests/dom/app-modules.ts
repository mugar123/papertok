import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner } from 'vite';
import type { FirebaseStub } from './firebase-stub.ts';

/**
 * Loads app modules the way the build does, inside `node --test`, which cannot
 * read `.tsx`, CSS imports or `import.meta.env` itself. Vite's module runner
 * transforms them; React, React DOM and React Router stay the one copy the test
 * imports, so a provider and the hooks that read it share a context.
 *
 * `services/firebase.ts` is the one module replaced: the real one starts a
 * Firebase app and a browser sign-in. The Worker is not replaced. The tests
 * give it an origin and answer its `fetch`, so the app's own request and error
 * code run (see `renderApp`).
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const FIREBASE_STUB = fileURLToPath(new URL('./firebase-stub.ts', import.meta.url)).replaceAll('\\', '/');
const WORKER_ORIGIN = 'https://api.papertok.app';

export async function startAppModules() {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    // No .env files: a developer's would differ from CI's.
    envDir: false,
    optimizeDeps: { noDiscovery: true },
    define: { 'import.meta.env.VITE_PAPER_API_BASE_URL': JSON.stringify(WORKER_ORIGIN) },
    resolve: { alias: [{ find: /^(?:.*\/)?firebase\.ts$/, replacement: FIREBASE_STUB }] },
  });
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  return {
    load: <T>(path: string) => runner.import<T>(path),
    firebase: () => runner.import<FirebaseStub>(FIREBASE_STUB),
    async close() {
      await runner.close();
      await server.close();
    },
  };
}

/** `worker-api-client.ts` with the Firebase stub, so a test can move `auth.currentUser`. */
export async function loadWorkerApiClient() {
  const app = await startAppModules();
  try {
    return { client: await app.load<typeof import('../../src/services/worker-api-client.ts')>('/src/services/worker-api-client.ts'), firebase: app.firebase, close: app.close };
  } catch (error) {
    await app.close();
    throw error;
  }
}
