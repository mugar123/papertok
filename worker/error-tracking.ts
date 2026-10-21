import * as Sentry from '@sentry/cloudflare';
import type { WorkerEnv } from './env.ts';
import { ERROR_DATA_COLLECTION, sanitizeErrorEvent } from '../src/utils/errorTelemetry.ts';

export function workerSentryOptions(env: WorkerEnv): Sentry.CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT || 'production',
    dataCollection: { ...ERROR_DATA_COLLECTION, httpBodies: [] },
    tracesSampleRate: 0,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    maxBreadcrumbs: 0,
    defaultIntegrations: false,
    beforeSend: sanitizeErrorEvent,
  };
}

export function captureWorkerException(error: unknown, operation: 'http' | 'rewrite' | 'schedule' = 'http') {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status < 500) return;
  Sentry.captureException(error, { tags: { operation } });
}

export function captureWorkerResponseFailure(status: number) {
  if (status < 500 || Sentry.lastEventId()) return;
  Sentry.captureException(new Error('Worker returned a server error'), { tags: { operation: 'http', http_status: status } });
}
