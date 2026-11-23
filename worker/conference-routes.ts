import type { Paper } from '../src/models/paper.ts';
import type { WorkerEnv } from './env.ts';
import { conferenceSources } from './conference-membership.ts';
import { cacheResponse } from './provider-runtime.ts';
import { reserveCallerMinute } from './caller-quota.ts';

type StatusRow = { edition_id: string; checked_at: number | null; stale_since: number | null; listed: number };

function publicStatus(row: StatusRow) {
  return { id: row.edition_id, updatedAt: row.checked_at, staleSince: row.stale_since, listed: row.listed };
}

export async function handleConferenceRequest(request: Request, env: WorkerEnv, origin: string, cors: HeadersInit) {
  const url = new URL(request.url);
  const headers = new Headers(cors);
  headers.set('cache-control', 'no-store');
  const result = (code: string, status: number) => Response.json({ code }, { status, headers });
  if (request.method !== 'GET') return result('METHOD_NOT_ALLOWED', 405);
  const isStatus = url.pathname === '/conferences/status';
  const id = url.pathname.match(/^\/conferences\/([a-z0-9-]+)\/papers$/)?.[1];
  if (!isStatus && (!id || !conferenceSources.has(id))) return result('CONFERENCE_NOT_FOUND', 404);

  const after = url.searchParams.get('after');
  if (after !== null && !/^[0-3][a-f0-9]{64}$/.test(after)) return result('INVALID_CURSOR', 400);
  const db = env.PAPER_STORE;
  if (!db || env.CONFERENCE_PAPERS_ENABLED !== '1') return result('CONFERENCE_LISTS_UNAVAILABLE', 503);
  try {
    const quota = await reserveCallerMinute(request, env, 'conference-public', 30);
    if (!quota.reading.accepted) {
      headers.set('retry-after', quota.retryAfter);
      return quota.reading.code ? result('CONFERENCE_LISTS_UNAVAILABLE', 503) : result('RATE_LIMITED', 429);
    }
    if (isStatus) {
      return await cacheResponse(request, origin, env, 600, async () => {
        const rows = await db.prepare(`
          SELECT e.edition_id, e.checked_at, e.stale_since, COUNT(p.paper_id) AS listed
          FROM conference_editions e LEFT JOIN conference_papers p ON e.edition_id = p.edition_id AND p.visible = 1
          GROUP BY e.edition_id
        `).all<StatusRow>();
        return { editions: rows.results.map(publicStatus) };
      }, { canonicalParams: {} });
    }
    return await cacheResponse(request, origin, env, 120, async () => {
      const rows = await db.prepare(`
        SELECT sort_key, paper, track FROM conference_papers
        WHERE edition_id = ? AND visible = 1 AND sort_key > ?
        ORDER BY sort_key LIMIT 16
      `).bind(id, after ?? '').all<{ sort_key: string; paper: string; track: string | null }>();
      const page = rows.results.slice(0, 15);
      const papers = page.map(row => ({ paper: JSON.parse(row.paper) as Paper, track: row.track }));
      return { papers, next: rows.results.length > 15 ? page.at(-1)?.sort_key : null };
    }, { canonicalParams: { after: after ?? '' } });
  } catch (error) {
    console.warn('Conference list read failed', error instanceof Error ? error.name : 'unknown');
    headers.set('cache-control', 'no-store');
    return result('CONFERENCE_LISTS_UNAVAILABLE', 503);
  }
}
