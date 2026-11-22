import { startAppModules } from './app-modules.ts';

/**
 * The part of the email service these tests call. Written out here because
 * the service's own module is typed for the browser build (`import.meta.env`,
 * the icon set), which this folder's Node project does not load.
 */
interface EmailNotificationService {
  startEmailDigestOptIn: (
    yes: { consent: string; interests: readonly string[]; follows?: object[]; previewItems?: object[] },
    uid: string,
  ) => Promise<{ outcome: string; preferences: object }>;
  buildNotificationPreferencesPayload: (
    preferences: { enabled?: boolean },
    follows?: object[],
    previewItems?: object[],
  ) => { follows: unknown[]; previewItems: unknown[] };
}

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
