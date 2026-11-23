import type { Paper } from '../src/models/paper.ts';
import type { WorkerEnv } from './env.ts';
import { conferenceSources } from '../src/data/conference-paper-sources.ts';
import { cacheResponse } from './provider-runtime.ts';
import { reserveCallerMinute } from './caller-quota.ts';
import { json } from './http.ts';

type StatusRow = { edition_id: string; checked_at: number | null; stale_since: number | null; listed_count: number; source_count: number | null; revision: number };

function publicStatus(row: StatusRow) {
  return { id: row.edition_id, updatedAt: row.checked_at, staleSince: row.stale_since, listed: row.listed_count, sourceCount: row.source_count };
}

export async function handleConferenceRequest(request: Request, env: WorkerEnv, origin: string, cors: HeadersInit) {
  const url = new URL(request.url);
  const headers = { ...Object.fromEntries(new Headers(cors)), 'cache-control': 'no-store' };
  const result = (code: string, status: number, extra?: Record<string, string>) => json({ code }, status, { ...headers, ...extra });
  if (request.method !== 'GET') return result('METHOD_NOT_ALLOWED', 405, { allow: 'GET' });
  const isStatus = url.pathname === '/conferences/status';
  const id = url.pathname.match(/^\/conferences\/([a-z0-9-]+)\/papers$/)?.[1];
  if (!isStatus && (!id || !conferenceSources.has(id))) return result('CONFERENCE_NOT_FOUND', 404);

  const after = url.searchParams.get('after');
  if (after !== null && !/^[0-3][a-f0-9]{64}$/.test(after)) return result('INVALID_CURSOR', 400);
  const db = env.PAPER_STORE;
  if (!db || env.CONFERENCE_PAPERS_ENABLED !== '1') return result('CONFERENCE_LISTS_UNAVAILABLE', 503);
  try {
    const quota = await reserveCallerMinute(request, env, isStatus ? 'conference-status' : 'conference-papers', isStatus ? 30 : 60);
    if (!quota.reading.accepted) {
      return quota.reading.code ? result('CONFERENCE_LISTS_UNAVAILABLE', 503) : result('RATE_LIMITED', 429, { 'retry-after': quota.retryAfter });
    }
    if (isStatus) {
      const rows = await db.prepare(`
        SELECT edition_id, checked_at, stale_since, listed_count, source_count, revision FROM conference_editions ORDER BY edition_id
      `).all<StatusRow>();
      return await cacheResponse(request, origin, env, 120, async () => ({ editions: rows.results.map(publicStatus) }), {
        canonicalParams: { revision: rows.results.map(row => row.edition_id + ':' + row.revision).join(',') },
      });
    }
    const edition = await db.prepare('SELECT revision FROM conference_editions WHERE edition_id = ?').bind(id).first<{ revision: number }>();
    return await cacheResponse(request, origin, env, 120, async () => {
      const rows = await db.prepare(`
        SELECT sort_key, paper, track FROM conference_papers
        WHERE edition_id = ? AND visible = 1 AND sort_key > ?
        ORDER BY sort_key LIMIT 16
      `).bind(id, after ?? '').all<{ sort_key: string; paper: string; track: string | null }>();
      const page = rows.results.slice(0, 15);
      const papers = page.map(row => ({ paper: JSON.parse(row.paper) as Paper, track: row.track }));
      return { papers, next: rows.results.length > 15 ? page.at(-1)?.sort_key : null };
    }, { canonicalParams: { after: after ?? '', revision: edition?.revision ?? 0 } });
  } catch (error) {
    console.warn('Conference list read failed', error instanceof Error ? error.name : 'unknown');
    return result('CONFERENCE_LISTS_UNAVAILABLE', 503);
  }
}
