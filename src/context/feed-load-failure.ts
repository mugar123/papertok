import { WorkerApiAuthError } from '../services/worker-api-client.ts';

/**
 * Why a feed load ended in "Error loading papers" (ENG-116). Every failure
 * used to reach the reader and the `app_error` event as the same state, so a
 * deadline, a refused token, a Worker outage and a page with no papers could
 * not be told apart. Fixed labels only: never the message, which can carry ids.
 */
type FeedLoadFailureReason =
  | 'timeout' | 'network' | 'session' | 'auth' | 'rate_limited' | 'rejected' | 'server'
  | 'invalid_response' | 'empty' | 'unexpected';

export interface FeedLoadFailure {
  reason: FeedLoadFailureReason;
  /** The HTTP status the Worker answered with. */
  status?: number;
  /** The Worker's or the client's error code, when it gave one. */
  code?: string;
}

const EMPTY_FIRST_PAGE = 'FEED_EMPTY_FIRST_PAGE';

/** A first page with no paper to show, which the feed treats as a failure. */
export function emptyFirstPageError() {
  return Object.assign(new Error('The paper store has no papers for these interests yet.'), { code: EMPTY_FIRST_PAGE });
}

function httpReason(status: number): FeedLoadFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server' : 'rejected';
}

export function feedLoadFailure(error: unknown): FeedLoadFailure {
  if (!(error instanceof Error)) return { reason: 'unexpected' };
  const { status, code } = error as Error & { status?: unknown; code?: unknown };
  const knownCode = typeof code === 'string' && code ? code : undefined;
  if (knownCode === EMPTY_FIRST_PAGE) return { reason: 'empty' };
  // AbortSignal.timeout rejects with a TimeoutError (utils/request-deadline.ts).
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return { reason: 'timeout' };
  if (error instanceof WorkerApiAuthError) return { reason: 'session', code: error.code };
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400) {
    return { reason: httpReason(status), status, ...(knownCode ? { code: knownCode } : {}) };
  }
  if (knownCode === 'STORE_RESPONSE_INVALID' || error instanceof SyntaxError) {
    return { reason: 'invalid_response', ...(knownCode ? { code: knownCode } : {}) };
  }
  // The store service marks a request that got no answer (paper-store-service.ts);
  // a TypeError from our own code is not one.
  if (knownCode === 'STORE_UNREACHABLE') return { reason: 'network', code: knownCode };
  // Getting the Firebase token failed before any request was made.
  if (knownCode?.startsWith('auth/')) {
    return { reason: knownCode === 'auth/network-request-failed' ? 'network' : 'session', code: knownCode };
  }
  return { reason: 'unexpected' };
}
