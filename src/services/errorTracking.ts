import type * as Sentry from '@sentry/react';
import { ANALYTICS_CONSENT, readAnalyticsConsent } from './analyticsService.ts';
import { ERROR_DATA_COLLECTION, sanitizeErrorEvent } from '../utils/errorTelemetry.ts';

let sdk: Promise<typeof Sentry | null> | null = null;

export function initializeErrorTracking() {
  if (!['papertok.app', 'www.papertok.app'].includes(globalThis.location?.hostname)
    || readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED) return Promise.resolve(null);
  sdk ??= import('@sentry/react').then(client => {
    client.init({
      // Public ingestion key; it cannot read events or administer the project.
      dsn: 'https://09c5909a538acfef0616ba466b118905@o4512294949421056.ingest.de.sentry.io/4512294963511376',
      environment: 'production',
      dataCollection: { ...ERROR_DATA_COLLECTION, httpBodies: [] },
      tracesSampleRate: 0,
      beforeSendLog: () => null,
      beforeSendMetric: () => null,
      maxBreadcrumbs: 0,
      integrations: [client.globalHandlersIntegration(), client.browserApiErrorsIntegration(), client.dedupeIntegration()],
      defaultIntegrations: false,
      beforeSend: event => readAnalyticsConsent() === ANALYTICS_CONSENT.GRANTED ? sanitizeErrorEvent(event) : null,
    });
    return client;
  }).catch(() => null);
  return sdk;
}

export async function captureAppException(error: unknown) {
  const client = await initializeErrorTracking();
  client?.captureException(error, { tags: { operation: 'render' } });
}
