import type { OpenAlexWork } from './openalex-api.ts';
import type { ShareProviders, OpenAireProjects } from './share-pages.ts';
import type { UpstreamError } from './provider-runtime.ts';
import type { QuotaRequest } from './request-quota-ledger.ts';
import type { WorkerEnv } from './env.ts';

import { createFirestoreRest } from '../src/utils/firestoreRest.ts';
import { ARXIV_PACE_MAX_WAIT_MS, ARXIV_PACE_PERIOD_MS, ARXIV_UPSTREAM_TIMEOUT_MS } from './arxiv-api.ts';
import { addOpenAlexCredentials } from './openalex-api.ts';
import { fetchWithDeadline, OPENALEX_CALLS, releaseHeld, reserveOpenAlexBudget } from './provider-runtime.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { createShareLoader, createShellLoader, handleSharePage } from './share-pages.ts';
import { awaitUpstreamSlot } from './upstream-pace.ts';

// The share pages (worker/share-pages.ts) are public and carry no Origin, so a
// cache miss is the one thing a scripted caller can make them spend: a random
// key per request misses every time. These ceilings bound the misses before
// any provider is asked, and each OpenAlex call is then reserved against the
// shared OpenAlex budget like any relay call, so the day's ceiling still sees
// every call it pays for. At most one miss in eight of that budget can be a
// share page. The minute ceiling only smooths bursts: a fan-out of one link
// misses once per data centre, since the edge cache is per data centre, so it
// leaves room for several at once (review of 2026-09-25). arXiv gets its own
// ceiling, a tenth of the app's one call every three seconds, and a share page
// asks it only for a preprint OpenAlex has not indexed yet.
const SHARE_LOOKUP_MINUTE_LIMIT = 60;
const SHARE_LOOKUP_DAILY_LIMIT = 1_000;
const SHARE_ARXIV_HOURLY_LIMIT = 120;
const SHARE_UPSTREAM_TIMEOUT_MS = 6_000;

// What was reserved, for whoever has to give it back, or null when a ceiling
// refused (having given back what it had taken).
async function reserveShareCeilings(env: WorkerEnv, periods: Array<[string, number]>) {
  const taken: QuotaRequest[] = [];
  for (const [periodKey, limit] of periods) {
    const ledgerRequest = { periodKey, subject: 'share:pages', subjectLimit: limit, globalLimit: limit, amount: 1 };
    const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, ledgerRequest);
    if (!reservation.accepted) {
      await releaseHeld(env, taken);
      return null;
    }
    taken.push(ledgerRequest);
  }
  return taken;
}

async function admitShareLookup(env: WorkerEnv) {
  const now = new Date().toISOString();
  return Boolean(await reserveShareCeilings(env, [
    [`share:${now.slice(0, 16)}`, SHARE_LOOKUP_MINUTE_LIMIT],
    [`share:day:${now.slice(0, 10)}`, SHARE_LOOKUP_DAILY_LIMIT],
  ]));
}

function shareUpstreamError(provider: string, response: Response) {
  const error: UpstreamError = new Error(`${provider} answered ${response.status} for a share page`);
  error.status = response.status;
  return error;
}

function shareProviders(env: WorkerEnv): ShareProviders {
  let firestore: ReturnType<typeof createFirestoreRest> | null = null;
  return {
    async openAlex(path, params = {}) {
      const url = addOpenAlexCredentials(new URL(`https://api.openalex.org/${path}`), env);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const budget = await reserveOpenAlexBudget(env, '', OPENALEX_CALLS.relay);
      if (budget.error) throw new Error('The OpenAlex budget refused a share page');
      const response = await fetchWithDeadline(url, { headers: { accept: 'application/json' } }, SHARE_UPSTREAM_TIMEOUT_MS);
      if (response.status === 404) return null;
      if (!response.ok) throw shareUpstreamError('OpenAlex', response);
      return response.json<OpenAlexWork & { results?: OpenAlexWork[] }>();
    },
    async arxiv(id) {
      const hour = new Date().toISOString().slice(0, 13);
      const held = await reserveShareCeilings(env, [[`share:arxiv:${hour}`, SHARE_ARXIV_HOURLY_LIMIT]]);
      if (!held) throw new Error('The arXiv ceiling for share pages is spent');
      // The same beat as `/arxiv`: a share page waits its turn like the feed.
      const seat = await awaitUpstreamSlot(env.REQUEST_QUOTA_LEDGER, {
        namespace: 'arxiv',
        periodMs: ARXIV_PACE_PERIOD_MS,
        maxWaitMs: ARXIV_PACE_MAX_WAIT_MS,
      });
      // No seat, no call: the hour's unit goes back. Kept, a burst drained the
      // hour without a single call to arXiv (review of 2026-09-25).
      if (!seat.accepted && !seat.code) {
        await releaseHeld(env, held);
        throw new Error('No arXiv seat for a share page');
      }
      const url = new URL('https://export.arxiv.org/api/query');
      url.searchParams.set('id_list', id);
      url.searchParams.set('max_results', '1');
      const response = await fetchWithDeadline(url.toString(), {
        headers: {
          accept: 'application/atom+xml, application/xml, text/xml;q=0.9',
          'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
        },
      }, ARXIV_UPSTREAM_TIMEOUT_MS);
      if (!response.ok) throw shareUpstreamError('arXiv', response);
      return response.text();
    },
    async openAire(params) {
      const url = new URL('https://api.openaire.eu/search/projects');
      url.searchParams.set('format', 'json');
      url.searchParams.set('size', '1');
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const response = await fetchWithDeadline(url, { headers: { accept: 'application/json' } }, SHARE_UPSTREAM_TIMEOUT_MS);
      if (!response.ok) throw shareUpstreamError('OpenAIRE', response);
      return response.json<OpenAireProjects>();
    },
    // Anonymous, on purpose: with no credential the rules decide exactly as
    // they do for a visitor.
    firestore: {
      getDocument(path) {
        firestore ||= createFirestoreRest({
          projectId: String(env.FIREBASE_PROJECT_ID || '').trim(),
          fetchImpl: (url, init) => fetchWithDeadline(url, init, SHARE_UPSTREAM_TIMEOUT_MS),
        });
        return firestore.getDocument(path);
      },
    },
  };
}

export async function handleShareRoute(request: Request, env: WorkerEnv) {
  try {
    return await handleSharePage(request, {
      loadShell: createShellLoader({
        fetchShell: shellUrl => fetchWithDeadline(shellUrl, { headers: { accept: 'text/html' } }, SHARE_UPSTREAM_TIMEOUT_MS),
      }),
      loadRecord: createShareLoader(shareProviders(env)),
      admit: () => admitShareLookup(env),
    });
  } catch (error) {
    console.error('Share page failed', error);
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'retry-after': '60', 'cache-control': 'no-store' },
    });
  }
}
