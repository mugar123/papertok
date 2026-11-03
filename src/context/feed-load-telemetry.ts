import type { ProductAnalyticsEvent } from '../services/analytics-service.ts';
import { feedLoadFailure } from './feed-load-failure.ts';

export type FeedLoadType = 'initial' | 'refresh' | 'load_more';
export type FeedLoadAttempt = 'original' | 'automatic_retry' | 'continuation';
type Outcome = { result: 'success' | 'empty' | 'continued' | 'superseded'; degraded?: boolean }
  | { result: 'error'; error: unknown };

/** One accepted loadPapers invocation, including token acquisition and local ranking. */
export function startFeedLoad({ loadType, attempt, firstScreen, track, isCurrentAccount, now = () => performance.now() }: {
  loadType: FeedLoadType;
  attempt: FeedLoadAttempt;
  firstScreen: boolean;
  track: (event: ProductAnalyticsEvent, properties: Record<string, unknown>) => Promise<unknown>;
  isCurrentAccount: () => boolean;
  now?: () => number;
}) {
  const started = now();
  const dimensions = { load_type: loadType, attempt, first_screen: firstScreen,
    client_release: (import.meta as ImportMeta & { env?: { VITE_APP_RELEASE?: string } }).env?.VITE_APP_RELEASE };
  let finished = false;
  let workerVersion: string | null = null;
  const send = (event: ProductAnalyticsEvent, properties: Record<string, unknown>) => {
    if (!isCurrentAccount()) return;
    // Reporting must never turn a successful feed load into a failed one.
    void track(event, properties).catch(() => {});
  };
  send('feed_load_started', dimensions);
  return {
    recordWorkerVersion(version: string | null) { workerVersion = version; },
    finish(outcome: Outcome) {
      if (finished) return;
      finished = true;
      const failure = outcome.result === 'error' ? feedLoadFailure(outcome.error) : null;
      send('feed_load_result', {
        ...dimensions, duration_ms: now() - started, worker_version: workerVersion,
        result: failure?.reason === 'empty' ? 'empty' : outcome.result,
        ...(failure ? { reason: failure.reason, status: failure.status, error_code: failure.code } : {}),
        ...('degraded' in outcome ? { degraded: outcome.degraded } : {}),
      });
    },
  };
}
