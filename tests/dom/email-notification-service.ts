import { startAppModules } from './app-modules.ts';

type EmailNotificationService = typeof import('../../src/services/email-notification-service.ts');

/**
 * The app's email service as the build loads it, with its Worker client and a
 * session a test sets through `signIn`. The test answers `fetch`.
 */
export async function loadEmailNotificationService() {
  const app = await startAppModules();
  try {
    const { auth } = await app.firebase();
    const signIn = (uid: string) => { auth.currentUser = { uid, getIdToken: async () => `${uid}-token` }; };
    const service = await app.load<EmailNotificationService>('/src/services/email-notification-service.ts');
    return { service, signIn, close: app.close };
  } catch (error) {
    await app.close();
    throw error;
  }
}
