import { AsyncLocalStorage } from 'node:async_hooks';
import { PostHog } from 'posthog-node';
import type { WorkerEnv } from './env.ts';
import { sanitizeExceptionProperties } from '../src/utils/error-telemetry.ts';

type Operation = 'http' | 'rewrite' | 'schedule' | 'durable_object' | 'workflow';
interface Invocation { client: PostHog | null; waitUntil(promise: Promise<unknown>): void; reported: boolean }

// Each request, schedule, Durable Object call and Workflow run reports through
// its own invocation, so a capture deep in a handler needs no env or context.
// Outside one (tests, scripts) capturing does nothing.
const invocations = new AsyncLocalStorage<Invocation>();
let client: PostHog | null = null;

function errorClient(token: string | undefined) {
  if (!token) return null;
  client ??= new PostHog(token, {
    host: 'https://eu.i.posthog.com',
    // During a PostHog outage a report costs one short request, not four.
    fetchRetryCount: 0,
    requestTimeout: 5000,
    disableGeoip: true,
    before_send: event => {
      const properties = event.event === '$exception' && event.properties ? sanitizeExceptionProperties(event.properties) : null;
      return properties && { ...event, properties: { ...properties, $process_person_profile: false } };
    },
  });
  return client;
}

export function trackErrors<Result>(env: WorkerEnv, context: Pick<ExecutionContext, 'waitUntil'>, operation: Operation, run: () => Promise<Result>) {
  const invocation: Invocation = { client: errorClient(env.POSTHOG_PROJECT_TOKEN), waitUntil: promise => context.waitUntil(promise), reported: false };
  return invocations.run(invocation, async () => {
    try {
      return await run();
    } catch (error) {
      captureWorkerException(error, operation);
      throw error;
    }
  });
}

function report(error: unknown, properties: Record<string, unknown>) {
  const invocation = invocations.getStore();
  if (!invocation?.client) return;
  invocation.reported = true;
  invocation.waitUntil(invocation.client.captureExceptionImmediate(error, 'papertok-worker', properties)
    .catch(() => console.warn('An error report could not be prepared for PostHog')));
}

export function captureWorkerException(error: unknown, operation: Operation = 'http') {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status < 500) return;
  report(error, { operation });
}

export function captureEmailSendLimit() {
  report(new Error('Email send limit reached'), { operation: 'schedule', email_limit: 'reached' });
}

export function captureWorkerResponseFailure(status: number) {
  if (status < 500 || invocations.getStore()?.reported) return;
  report(new Error('Worker returned a server error'), { operation: 'http', http_status: status });
}
