import type { Paper } from '../models/Paper.ts';

import { mapICitePublication, normalizePmid } from './iCiteRecords.ts';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_PMIDS = 200;

export async function fetchICiteMetrics(papersOrPmids: Array<Partial<Paper> | string>): Promise<Record<string, Partial<Paper>>> {
  const pmids = [...new Set((papersOrPmids || []).map(item => normalizePmid((item as Partial<Paper>)?.pmid ?? item)).filter(Boolean))]
    .slice(0, MAX_PMIDS);
  if (!PAPER_API_BASE || pmids.length === 0) return {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(`${PAPER_API_BASE}/enrich/icite`);
    url.searchParams.set('pmids', pmids.join(','));
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return {};
    const payload = await response.json() as { data?: Array<Record<string, unknown>> };
    return Object.fromEntries((payload?.data || []).map(mapICitePublication).filter(Boolean).map(item => [item!.pmid, item!]));
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}
