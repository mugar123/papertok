import { createContext } from 'react';

/**
 * Lives apart from toggle-group.jsx so the context object keeps a stable
 * identity: a module that defines a component is a Fast Refresh boundary, and
 * re-evaluating it would mint a new context that already-mounted consumers
 * would not be holding.
 */
export const ToggleGroupContext = createContext({ size: 'default', variant: 'default' });
