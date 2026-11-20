import './dom-environment.ts';
import { createElement, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, render } from '@testing-library/react';
import { startAppModules } from './app-modules.ts';
import { stubWorker } from './worker-stub.ts';

/**
 * The whole app, as `main.tsx` mounts it, for a reader with no session, at
 * `address` (a path with its query and fragment). The reader's browser is
 * jsdom's `window`, so a test reads the address and history the app leaves there.
 * The Worker answers nothing: a request the first screens make is unreachable.
 */
export async function renderApp(address: string) {
  const app = await startAppModules();
  const worker = stubWorker();
  const stop = async () => {
    cleanup();
    worker.stop();
    await app.close();
  };
  // A setup that throws still releases the Vite server and `fetch`.
  try {
    window.history.replaceState(null, '', address);
    const { default: App } = await app.load<{ default: () => ReactNode }>('/src/app.tsx');
    render(createElement(BrowserRouter, null, createElement(App)));
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
