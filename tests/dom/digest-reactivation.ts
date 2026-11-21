import './dom-environment.ts';
import { createElement, type ComponentType, type Context } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { UseDigestReactivation } from '../../src/hooks/digest-reactivation-types.ts';
import { startAppModules } from './app-modules.ts';

export async function loadDigestReactivation() {
  const app = await startAppModules();
  try {
    const { auth } = await app.firebase();
    auth.currentUser = { uid: 'reader', getIdToken: async () => 'test-token' };
    const { useDigestReactivation } = await app.load<{ useDigestReactivation: UseDigestReactivation }>('/src/hooks/use-digest-reactivation.ts');
    const { default: Modal } = await app.load<{ default: ComponentType<{ isOpen: boolean; onClose: () => void }> }>('/src/components/following/email-notification-modal.tsx');
    const { AuthContext, LanguageContext, EmailNotificationsContext, FollowingContext } =
      await app.load<Record<'AuthContext' | 'LanguageContext' | 'EmailNotificationsContext' | 'FollowingContext', Context<unknown>>>('/src/context/contexts.ts');
    // Settings with the digest preferences read (`subscribed`: true) or failed
    // (null), and its email dialog open or closed.
    function ReminderSettings({ subscribed = true, isOpen = true }: { subscribed?: boolean | null; isOpen?: boolean }) {
      const reactivation = useDigestReactivation('reader', subscribed, true);
      return createElement(MemoryRouter, {},
        createElement(AuthContext.Provider, { value: { user: { emailVerified: true } } },
          createElement(LanguageContext.Provider, { value: { language: 'en' } },
            createElement(FollowingContext.Provider, { value: { followedEntities: [] } },
              createElement(EmailNotificationsContext.Provider, { value: {
                preferences: { enabled: subscribed === true, email: 'reader@example.com', maxPapers: 5 },
                digestSubscribed: subscribed,
                health: { configured: true, available: true },
                digestCovered: true, digestSendReady: true, notificationDataReady: true, reactivation,
              } }, createElement(Modal, { isOpen, onClose: () => {} }))))));
    }
    return { useDigestReactivation, ReminderSettings, close: app.close };
  } catch (error) {
    await app.close();
    throw error;
  }
}
