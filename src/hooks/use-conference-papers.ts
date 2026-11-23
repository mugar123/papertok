import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paper } from '../models/paper.ts';
import { trustedWorkerUrl } from '../services/worker-api-client.ts';
import { withEnforcedDeadline } from '../utils/request-deadline.ts';

type EditionStatus = { id: string; listed: number; updatedAt: number | null; staleSince: number | null };
type Page = { papers: { paper: Paper; track: string | null }[]; next: string | null };

async function getConferenceData<T>(path: string, signal: AbortSignal) {
  const base = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  const url = base && trustedWorkerUrl(base + path);
  if (!url) throw new Error('Conference lists unavailable');
  const response = await fetch(url, withEnforcedDeadline({ signal, credentials: 'omit' }));
  if (!response.ok) throw new Error('Conference lists unavailable');
  return response.json() as Promise<T>;
}

export function useConferenceStatus(id: string | undefined) {
  const [status, setStatus] = useState<EditionStatus | null>(null);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    void getConferenceData<{ editions: EditionStatus[] }>('/conferences/status', controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setStatus(result.editions.find(edition => edition.id === id) ?? null);
      })
      .catch(() => { if (!controller.signal.aborted) setStatus(null); });
    return () => controller.abort();
  }, [id]);
  return status?.id === id ? status : null;
}

type PapersState = { entries: Page['papers']; next: string | null; loading: boolean; error: boolean };
const initial: PapersState = { entries: [], next: null, loading: true, error: false };

export function useConferencePapers(id: string) {
  const [state, setState] = useState(initial);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback((cursor: string | null) => {
    if (pending.current) return false;
    const controller = new AbortController();
    pending.current = controller;
    setState(current => ({ ...current, loading: true, error: false }));
    const after = cursor ? '?after=' + encodeURIComponent(cursor) : '';
    void getConferenceData<Page>('/conferences/' + encodeURIComponent(id) + '/papers' + after, controller.signal)
      .then(page => {
        if (controller.signal.aborted) return;
        setState(current => {
          const rows = cursor ? [...current.entries, ...page.papers] : page.papers;
          const entries = [...new Map(rows.map(row => [row.paper.id, row])).values()];
          return { entries, next: page.next, loading: false, error: false };
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: true }));
      })
      .finally(() => { if (pending.current === controller) pending.current = null; });
    return true;
  }, [id]);
  useEffect(() => {
    load(null);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [load]);
  return { ...state, loadMore: () => state.next ? load(state.next) : false, refresh: () => load(null) };
}
