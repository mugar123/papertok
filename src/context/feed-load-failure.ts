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
  // A build with no allowed Worker origin is a deployment fault, not the reader's session.
  if (error instanceof WorkerApiAuthError) {
    return { reason: error.code === 'WORKER_ORIGIN_NOT_ALLOWED' ? 'unexpected' : 'session', code: error.code };
  }
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
  if (knownCode === 'auth/network-request-failed') return { reason: 'network', code: knownCode };
  if (knownCode === 'auth/too-many-requests') return { reason: 'rate_limited', code: knownCode };
  if (knownCode?.startsWith('auth/')) return { reason: 'session', code: knownCode };
  return { reason: 'unexpected' };
}

/**
 * What the feed shows for a failed load. A store with no papers for these
 * interests is an empty state, and asking again at once gets the same answer,
 * so only a failed request retries on its own.
 */
export function feedLoadOutcome(error: unknown) {
  return feedLoadFailure(error).reason === 'empty'
    ? { error: 'FEED_EMPTY', autoRetry: false }
    : { error: 'FEED_LOAD_FAILED', autoRetry: true };
}

/** The `app_error` a failed load owes. */
function feedLoadFailedEvent(error: unknown) {
  const { reason, status, code } = feedLoadFailure(error);
  return { kind: 'feed_load_failed', reason, status, error_code: code };
}

type FeedLoadFailedEvent = ReturnType<typeof feedLoadFailedEvent>;

interface FeedScreen {
  feedVisible: boolean;
  error: string | null;
  shownPapers: number;
}

/**
 * Whether the reader is looking at the error now. The provider keeps loading
 * on other pages, so a failure there is held until the reader returns to
 * /feed and the error is still on screen.
 */
function feedErrorOnScreen({ feedVisible, error, shownPapers }: FeedScreen) {
  return feedVisible && error !== null && shownPapers === 0;
}

type FeedFailureChange =
  | { kind: 'load_started' }
  | { kind: 'load_failed'; failure: unknown; screen: FeedScreen }
  | { kind: 'screen_changed'; screen: FeedScreen };

/**
 * What the provider does with the `app_error` a failed load owes. It is sent
 * once, where the load runs, when the reader sees the error: at once on /feed
 * with no card, or later, when the last card is dismissed or the reader
 * returns to /feed. A new load drops the event a previous attempt still held.
 */
export function feedFailureEventStep(held: FeedLoadFailedEvent | null, change: FeedFailureChange) {
  if (change.kind === 'load_started') return { send: null, hold: null };
  const owed = change.kind === 'load_failed' ? feedLoadFailedEvent(change.failure) : held;
  if (!owed) return { send: null, hold: null };
  return feedErrorOnScreen(change.screen) ? { send: owed, hold: null } : { send: null, hold: owed };
}
