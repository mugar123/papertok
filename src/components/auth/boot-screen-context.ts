import { createContext, useContext, useLayoutEffect } from 'react';

/**
 * Set by `ProtectedRoute` while it holds its loader over a page; null
 * elsewhere. Its own module, without JSX, so Fast Refresh does not re-create
 * the context under its consumers.
 */
const BootScreenContext = createContext<(() => void) | null>(null);

export const BootScreenProvider = BootScreenContext.Provider;

/** Takes the boot screen down once `ready`, before the frame that shows the page. */
export function useReleaseBootScreen(ready: boolean) {
  const release = useContext(BootScreenContext);
  useLayoutEffect(() => {
    if (ready) release?.();
  }, [ready, release]);
}
