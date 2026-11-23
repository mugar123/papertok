import { fileURLToPath } from 'node:url';
import type { PropsWithChildren, ReactNode } from 'react';
import { createServer, createServerModuleRunner } from 'vite';
import type { FirebaseStub } from './firebase-stub.ts';

/**
 * Loads app modules the way the build does, inside `node --test`, which cannot
 * read `.tsx`, CSS imports or `import.meta.env` itself. Vite's module runner
 * transforms them; React, React DOM and React Router stay the one copy the test
 * imports, so a provider and the hooks that read it share a context.
 *
 * The Firebase configuration is replaced so tests do not start a real session.
 * Tests that sign in also stub Firestore reads. The Worker is not replaced. The tests
 * give it an origin and answer its `fetch`, so the app's own request and error
 * code run (see `renderApp`).
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const FIREBASE_STUB = fileURLToPath(new URL('./firebase-stub.ts', import.meta.url)).replaceAll('\\', '/');
const FIRESTORE_STUB = fileURLToPath(new URL('./firestore-stub.ts', import.meta.url)).replaceAll('\\', '/');
const WORKER_ORIGIN = 'https://api.papertok.app';

export async function startAppModules({ stubFirestore = false } = {}) {
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
    resolve: { alias: [
      { find: /^(?:.*\/)?firebase\.ts$/, replacement: FIREBASE_STUB },
      ...(stubFirestore ? [{ find: /^firebase\/firestore$/, replacement: FIRESTORE_STUB }] : []),
    ] },
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

async function loadAppModule<T>(path: string, options?: Parameters<typeof startAppModules>[0]) {
  const app = await startAppModules(options);
  try {
    return { entry: await app.load<T>(path), firebase: app.firebase, close: app.close };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export function loadReaderTranslationControls() {
  return loadAppModule<typeof import('../../src/components/pdf/reader-translation-controls.tsx')>('/src/components/pdf/reader-translation-controls.tsx');
}

export function loadFullPaperTranslationHook() {
  return loadAppModule<typeof import('../../src/hooks/use-full-paper-translation.ts')>('/src/hooks/use-full-paper-translation.ts');
}

export function loadPaperTranslationService() {
  return loadAppModule<typeof import('../../src/services/paper-translation-service.ts')>('/src/services/paper-translation-service.ts');
}

interface AuthProviderModule {
  AuthProvider: (props: PropsWithChildren) => ReactNode;
  useAuth: () => { user: { uid: string } | null; loading: boolean };
}

export function loadAuthProvider() {
  return loadAppModule<AuthProviderModule>('/src/context/auth-context.tsx', { stubFirestore: true });
}
