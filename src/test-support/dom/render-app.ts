import './dom-environment.ts';
import { createElement } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, render } from '@testing-library/react';
import { startAppModules } from './app-modules.ts';
import { stubWorker } from './worker-stub.ts';

/**
 * The whole app, as `main.tsx` mounts it, for a reader with no session, at
 * `address` (a path with its query and fragment). The reader's browser is
 * jsdom's `window`, so a test reads the address and history the app leaves there.
 */
export async function renderApp(address: string) {
  const app = await startAppModules();
  const worker = stubWorker();
  // Nothing in the app's first screens is asked of the Worker or a provider here.
  const consoleOutput = { error: console.error, warn: console.warn, info: console.info };
  Object.assign(console, { error() {}, warn() {}, info() {} });
  window.history.replaceState(null, '', address);
  const { default: App } = await app.load<{ default: () => ReturnType<typeof createElement> }>('/src/app.tsx');
  render(createElement(BrowserRouter, null, createElement(App)));
  return {
    async stop() {
      cleanup();
      worker.stop();
      Object.assign(console, consoleOutput);
      await app.close();
    },
  };
}
