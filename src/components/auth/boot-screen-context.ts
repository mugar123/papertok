import { createContext, useContext, useLayoutEffect } from 'react';

/**
 * The release for the boot screen a reload opened a page under. `ProtectedRoute`
 * keeps its loader over a route that asked for it (`holdBootScreen`) and puts
 * the release here; everywhere else it is null. Its own module, without JSX,
 * so Fast Refresh does not re-create the context under its consumers.
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
