import './dom-environment.ts';
import { createElement, type ComponentType, type Context } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { useDigestReactivation as UseDigestReactivation } from '../../src/hooks/use-digest-reactivation.ts';
import { startAppModules } from './app-modules.ts';

export async function loadDigestReactivation() {
  const app = await startAppModules();
  try {
    const { auth } = await app.firebase();
    auth.currentUser = { uid: 'reader', getIdToken: async () => 'test-token' };
    const { useDigestReactivation } = await app.load<{ useDigestReactivation: typeof UseDigestReactivation }>('/src/hooks/use-digest-reactivation.ts');
    const { default: Modal } = await app.load<{ default: ComponentType<{ isOpen: boolean; onClose: () => void }> }>('/src/components/following/email-notification-modal.tsx');
    const { AuthContext, LanguageContext, EmailNotificationsContext, FollowingContext } =
      await app.load<Record<'AuthContext' | 'LanguageContext' | 'EmailNotificationsContext' | 'FollowingContext', Context<unknown>>>('/src/context/contexts.ts');
    function ReminderSettings() {
      const reactivation = useDigestReactivation('reader', true, true);
      return createElement(MemoryRouter, {},
        createElement(AuthContext.Provider, { value: { user: { emailVerified: true } } },
          createElement(LanguageContext.Provider, { value: { language: 'en' } },
            createElement(FollowingContext.Provider, { value: { followedEntities: [] } },
              createElement(EmailNotificationsContext.Provider, { value: {
                preferences: { enabled: true, email: 'reader@example.com', maxPapers: 5 },
                health: { configured: true, available: true },
                digestCovered: true, digestSendReady: true, notificationDataReady: true, reactivation,
              } }, createElement(Modal, { isOpen: true, onClose: () => {} }))))));
    }
    return { useDigestReactivation, ReminderSettings, close: app.close };
  } catch (error) {
    await app.close();
    throw error;
  }
}
