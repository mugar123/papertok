import { createContext } from 'react';

/**
 * Every React context object in the app, and nothing else.
 *
 * A context is matched by object identity, not by name: `useContext` only finds
 * a provider that pushed *the same object* `createContext` returned. Vite
 * re-evaluates a module whenever Fast Refresh invalidates it, so a
 * `createContext()` call that sits next to its provider component is re-run on
 * every edit and mints a *new* context object. Importers that were not
 * re-fetched in the same pass keep the previous one and their `useContext`
 * silently reads the default value — a correctly nested provider then throws
 * "must be used within a ...Provider", the first render of the whole app is
 * thrown away, and a real crash hides behind the error boundary that catches it.
 *
 * This module declares no components, so Fast Refresh never treats it as a
 * refresh boundary and editing a provider cannot re-create the context its
 * consumers are already holding. Production bundles each module exactly once
 * and never had the problem, which is why it only ever showed up in dev.
 *
 * Keep this file free of components and of anything that changes often.
 */
export const AnalyticsContext = createContext(null);
export const AuthContext = createContext(null);
export const EmailNotificationsContext = createContext(null);
export const FeedContext = createContext(null);
export const FollowingContext = createContext(null);
export const FollowingUpdatesContext = createContext(null);
export const LanguageContext = createContext(null);
