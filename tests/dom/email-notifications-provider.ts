import './dom-environment.ts';
import { createElement, useContext, type ComponentType, type Context, type PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import type { Plugin } from 'vite';
import { startAppModules } from './app-modules.ts';

/**
 * The provider listens to the reader's profile in Firestore, which the DOM
 * tests do not have. In its module alone, the Firestore client is replaced by
 * a listener that reports once what the server would: a confirmed profile with
 * one chosen subject. (The outside verifier of ENG-215 mounted the provider
 * this way first.)
 */
const PROFILE_MODULE = 'virtual:papertok-test-profile';
const confirmedProfile: Plugin = {
  name: 'papertok-test-profile',
  enforce: 'pre',
  transform(code, id) {
    return /email-notifications-context\.tsx/.test(id) ? code.replaceAll("'firebase/firestore'", `'${PROFILE_MODULE}'`) : undefined;
  },
  resolveId(id) {
    return id === PROFILE_MODULE ? `\0${PROFILE_MODULE}` : undefined;
  },
  load(id) {
    if (id !== `\0${PROFILE_MODULE}`) return undefined;
    return `export const doc = (...path) => path;
export function onSnapshot(_doc, _options, report) {
  let live = true;
  queueMicrotask(() => {
    if (live) report({ data: () => ({ preferences: ['cs.LG'] }), metadata: { fromCache: false, hasPendingWrites: false } });
  });
  return () => { live = false; };
}`;
  },
};

/** What the tests read and call on the provider's value. */
export interface EmailSettings {
  preferences: { enabled: boolean; maxPapers: number; email: string };
  loading: boolean;
  savePreferences(preferences: object): Promise<unknown>;
  sendTest(preferences?: object): Promise<unknown>;
  startWelcomeDigest(yes: { uid: string; interests: readonly string[] }): void;
}

const READER = { uid: 'reader', email: 'reader@example.com', emailVerified: true };

/**
 * The real email provider, with the app's own Worker client under it, for the
 * signed-in account `reader`: no follows, one chosen subject, a profile the
 * server confirmed. The app's Toaster is on the page, so a test reads and
 * presses the notices as a reader would. The test answers `fetch`. `pendingYes` is a yes kept in
 * the profile under the earlier welcome text, and `events` receives the
 * analytics events the provider reports.
 */
export async function loadEmailNotificationsProvider() {
  const app = await startAppModules({ plugins: [confirmedProfile] });
  try {
    const { auth } = await app.firebase();
    auth.currentUser = { ...READER, getIdToken: async () => 'reader-token' };
    const { EmailNotificationsProvider } = await app.load<{ EmailNotificationsProvider: ComponentType<PropsWithChildren> }>('/src/context/email-notifications-context.tsx');
    const contexts = await app.load<Record<string, Context<unknown>>>('/src/context/contexts.ts');
    // Toasts for an account show only once the app has named it as signed in.
    const { forgetAccountToasts, trackModalOverlay } = await app.load<{
      forgetAccountToasts: (uid: string | null) => void;
      trackModalOverlay: (portal: HTMLElement | null) => (() => void) | undefined;
    }>('/src/components/ui/toast.ts');
    forgetAccountToasts(READER.uid);
    // A dialog, drawer or sheet opening over the page, as its portal reports it; returns the way to close it.
    const openOverlay = () => {
      const portal = document.body.appendChild(document.createElement('div'));
      const close = trackModalOverlay(portal);
      return () => {
        close?.();
        portal.remove();
      };
    };
    const { Toaster } = await app.load<{ Toaster: ComponentType }>('/src/components/ui/sonner.tsx');

    function mount({ pendingYes = false, settlePendingYes = async () => {}, events = [] }: {
      pendingYes?: boolean; settlePendingYes?: () => Promise<void>; events?: unknown[][];
    } = {}) {
      let settings: EmailSettings | undefined;
      function Consumer() {
        settings = useContext(contexts.EmailNotificationsContext) as EmailSettings;
        return null;
      }
      const values: Array<[string, unknown]> = [
        ['FollowingUpdatesContext', { items: [], loading: false }],
        ['FollowingContext', { followedEntities: [], loading: false, error: null, confirmed: true }],
        ['AnalyticsContext', { trackEvent: async (...event: unknown[]) => { events.push(event); }, markActivation: async () => {} }],
        ['LanguageContext', { language: 'en' }],
        ['AuthContext', { user: READER, emailDigestPending: pendingYes, settleEmailDigestOptIn: settlePendingYes, userPreferences: ['cs.LG'], orcid: null }],
      ];
      const tree = values.reduce(
        (children, [name, value]) => createElement(contexts[name].Provider, { value }, children),
        createElement(EmailNotificationsProvider, null, createElement(Consumer)),
      );
      const toaster = createElement(contexts.ThemeContext.Provider, { value: { theme: 'light' } }, createElement(Toaster));
      const view = render(createElement(MemoryRouter, null, tree, toaster));
      return {
        settings: () => {
          if (!settings) throw new Error('The provider has not rendered yet');
          return settings;
        },
        unmount: () => { view.unmount(); },
      };
    }
    return { mount, openOverlay, close: app.close };
  } catch (error) {
    await app.close();
    throw error;
  }
}
