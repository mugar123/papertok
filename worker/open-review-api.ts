import type { OpenReviewNote } from '../src/services/open-review-service.ts';
import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { fetchWithDeadline, SOURCE_UPSTREAM_TIMEOUT_MS } from './provider-runtime.ts';

/**
 * OpenReview by id, signed in.
 *
 * OpenReview answers an anonymous `GET /notes?id=` with a 403
 * `ChallengeRequiredError` (measured through this Worker on 2026-11-11, for a
 * real id and a made-up one alike), and its check page offers "Sign in to skip
 * this check". `notes/search` is not checked, so the search in `source-api.ts`
 * stays anonymous. The sign-in is the one OpenReview's own Python client
 * performs: `POST /login` with `{ id, password }`, answered `{ token }`, sent
 * back as `Authorization: Bearer`.
 *
 * The account is `OPENREVIEW_USERNAME` and `OPENREVIEW_PASSWORD`, Cloudflare
 * secrets. It must not require a second factor: nobody is here to type a code.
 * It must also be an account made for this, with no role anywhere: OpenReview
 * shows an author, a reviewer or a chair what it hides from everyone else, and
 * what this account is shown is cached and served to every reader.
 * `publicNote` is the second guard for that, not a licence to use a personal
 * account.
 *
 * Only the newer API is asked. Venues that have not moved to it keep their
 * forums on `api.openreview.net`, whose notes have another shape; none was
 * observed, so a forum held only there is not found.
 */
const OPENREVIEW_API = 'https://api2.openreview.net';
const HEADERS = { accept: 'application/json', 'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)' };
// OpenReview's client documents a token as lasting an hour. A token is
// replaced before that rather than on a refusal, because what an expired one
// is answered with was not observed: a 401 is handled below, a 403 would look
// like the bot check.
const TOKEN_LIFETIME_MS = 50 * 60_000;
// How long a sign-in OpenReview refused is not tried again. `/sources/openreview`
// has no ceiling, so without this a wrong password would send the account's
// credentials to OpenReview once per request, whoever was asking.
const REFUSED_SIGN_IN_MS = 60_000;

interface Account { username: string; password: string }

// The token itself, never the promise of one: a promise belongs to the request
// that started it, and when that request is cancelled mid sign-in it never
// settles, for anyone waiting on it. Kept per isolate; a cold burst may sign in
// more than once.
const sessions = new Map<string, { token: string; signedInAt: number }>();
const refusedSignIns = new Map<string, { until: number; error: UpstreamError }>();

export function openReviewAccount(env: WorkerEnv): Account | null {
  const username = String(env.OPENREVIEW_USERNAME || '').trim();
  const password = String(env.OPENREVIEW_PASSWORD || '');
  return username && password ? { username, password } : null;
}

// No `status` on this failure, whatever OpenReview answered: the route gives a
// plain 502 and reports the error, where a relayed 4xx would read as OpenReview
// refusing the note. Usually it is ours to fix: a wrong password, an account
// that gained a second factor.
function signInFailure(reason: string) {
  const error: UpstreamError = new Error(`OpenReview sign-in ${reason}`);
  error.code = 'OPENREVIEW_SIGN_IN_FAILED';
  return error;
}

// What OpenReview said about a refused sign-in, for the log: a wrong password
// and an account that is not active yet are both a 400, and only its words
// tell them apart. The account's name is taken out of them.
function refusalReason(body: { name?: unknown; message?: unknown } | null, account: Account) {
  const words = [body?.name, body?.message]
    .filter(part => typeof part === 'string' && part)
    .join(': ')
    .replaceAll(account.username, '<account>')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  return words ? ` (${words})` : '';
}

async function signIn(account: Account, signal: AbortSignal, timeoutMs: number) {
  const refused = refusedSignIns.get(account.username);
  if (refused && refused.until > Date.now()) throw refused.error;

  const response = await fetchWithDeadline(`${OPENREVIEW_API}/login`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ id: account.username, password: account.password }),
    signal,
  }, timeoutMs);
  // A 2xx that is not JSON is a refusal like any other, and is remembered.
  const body = await response.json<{ token?: unknown; mfaPending?: unknown; name?: unknown; message?: unknown }>().catch(() => null);
  if (!response.ok || typeof body?.token !== 'string' || !body.token) {
    const error = signInFailure(
      !response.ok ? `answered ${response.status}${refusalReason(body, account)}`
        : body?.mfaPending ? 'asks for a second factor'
          : 'answered no token',
    );
    const askedToWaitMs = (Number(response.headers.get('retry-after')) || 0) * 1000;
    refusedSignIns.set(account.username, { until: Date.now() + Math.max(REFUSED_SIGN_IN_MS, askedToWaitMs), error });
    throw error;
  }
  refusedSignIns.delete(account.username);
  sessions.set(account.username, { token: body.token, signedInAt: Date.now() });
  return body.token;
}

export function isOpenReviewSubmission(note: OpenReviewNote) {
  const domain = String(note?.domain || '').toLowerCase();
  return ![
    'dblp.org',
    'openreview.net/public_article',
    'openreview.net/arxiv',
    'openreview.net/orcid',
  ].some(prefix => domain.startsWith(prefix));
}

type ReadableNote = OpenReviewNote & { readers?: unknown };

const forEveryone = (readers: unknown) => !Array.isArray(readers) || readers.includes('everyone');

// Only what OpenReview shows everyone. A note lists who may read it in
// `readers`, and so can each content field (the authors of a submission under
// double-blind review are readable by its venue and its authors only). An
// anonymous caller is never sent the rest; a signed-in one may be.
function publicNote(note: ReadableNote): OpenReviewNote | null {
  if (!forEveryone(note.readers)) return null;
  const content = Object.fromEntries(Object.entries(note.content || {})
    .filter(([, field]) => forEveryone((field as { readers?: unknown } | null)?.readers)));
  return { ...note, content };
}

/**
 * The submission an OpenReview forum id names, or null when OpenReview has no
 * such note or the id is a reply's (a review, a comment), which is no paper.
 * `GET /notes?id=` answers `{ notes: [note] }` and a 404 for an id it does not
 * have; a submission's `forum` is its own id. Any other refusal throws, with
 * its status.
 *
 * Null too for a record OpenReview imported (`isOpenReviewSubmission`) or one
 * a profile owner archived: the search leaves both out, since they copy a
 * paper published elsewhere, an archive copy often under its owner's name
 * alone, and the mapper would present either as an unreviewed preprint. And
 * null for a note not everyone may read; one that is public comes back without
 * the fields that are not (`publicNote`).
 *
 * `timeoutMs` covers the whole lookup, a sign-in included, not each request.
 */
export async function fetchOpenReviewNote(env: WorkerEnv, id: string, timeoutMs = SOURCE_UPSTREAM_TIMEOUT_MS) {
  const account = openReviewAccount(env);
  if (!account) {
    const error: UpstreamError = new Error('No OpenReview account is configured');
    error.code = 'OPENREVIEW_NOT_CONFIGURED';
    throw error;
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const ask = (token: string) => fetchWithDeadline(
    `${OPENREVIEW_API}/notes?id=${encodeURIComponent(id)}`,
    { headers: { ...HEADERS, authorization: `Bearer ${token}` }, signal },
    timeoutMs,
  );

  const kept = sessions.get(account.username);
  const keptToken = kept && Date.now() - kept.signedInAt < TOKEN_LIFETIME_MS ? kept.token : null;
  let response = await ask(keptToken ?? await signIn(account, signal, timeoutMs));
  // A kept token OpenReview no longer accepts gets one fresh sign-in. A token
  // issued for this very lookup and refused is a failure, not a reason to ask
  // for another.
  if (response.status === 401 && keptToken) {
    if (sessions.get(account.username)?.token === keptToken) sessions.delete(account.username);
    response = await ask(await signIn(account, signal, timeoutMs));
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const error: UpstreamError = new Error(`OpenReview answered ${response.status} for a note`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  const payload = await response.json<{ notes?: ReadableNote[] }>();
  const note = (payload?.notes || []).find(candidate => candidate?.id === id);
  if (!note) return null;
  const reply = (note.forum ?? id) !== id;
  const archived = String(note.domain || '').toLowerCase().startsWith('openreview.net/archive');
  return !reply && isOpenReviewSubmission(note) && !archived ? publicNote(note) : null;
}
