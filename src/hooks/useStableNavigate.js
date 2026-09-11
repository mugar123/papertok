import { useCallback, useContext } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';

/**
 * `navigate` for components that must NOT re-render on every navigation.
 *
 * react-router's `useNavigate` reads `useLocation()` (to resolve relative
 * paths), so every component that calls it re-renders whenever the location
 * changes — `memo` cannot stop a context update. `PaperCard` called it, and
 * measured on 2026-09-11 that was ~300 ms of the 380 ms synchronous block on
 * tapping a topic pill: fifteen to thirty mounted cards re-rendering for a
 * page they were about to be covered by, before the page transition could
 * even start.
 *
 * The `navigator` in NavigationContext is the history object itself and never
 * changes, so this hook subscribes to nothing that moves. The price is that
 * it only takes ABSOLUTE paths (or a number for `go`); there is no location
 * to resolve a relative one against, and the callers here never pass one.
 */
export function useStableNavigate() {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  return useCallback((to, options = {}) => {
    if (typeof to === 'number') {
      navigator.go(to);
      return;
    }
    if (typeof to === 'string' && !to.startsWith('/')) {
      throw new Error(`useStableNavigate takes absolute paths; got "${to}"`);
    }
    if (options.replace) navigator.replace(to, options.state, options);
    else navigator.push(to, options.state, options);
  }, [navigator]);
}
