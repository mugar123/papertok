import { markAppForcedReload, PRELOAD_RELOAD_KEY, PRELOAD_RELOAD_WINDOW_MS } from './app-reload.ts';

const optionalFailures = new WeakSet<object>();

export async function loadOptionalModule<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error !== null && typeof error === 'object') optionalFailures.add(error);
    return null;
  }
}

export function recoverModuleLoad(event: Event & { payload?: unknown }) {
  // Vite dispatches before rejecting the import. Leave the rejection intact so
  // its owner can classify an optional failure before the next task runs.
  setTimeout(() => {
    const error = event.payload;
    if (error !== null && typeof error === 'object' && optionalFailures.has(error)) return;
    const now = Date.now();
    try {
      const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY)) || 0;
      if (now - last < PRELOAD_RELOAD_WINDOW_MS) return;
      sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now));
    } catch {
      // Without storage there is no way to bound a reload loop.
      return;
    }
    markAppForcedReload();
    window.location.reload();
  }, 0);
}
