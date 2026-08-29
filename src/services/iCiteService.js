import { PaperBuilder } from './PaperBuilder.js';
import { paperFieldsEqual } from '../utils/feedEnrichment.js';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_PMIDS = 200;

function normalizePmid(value) {
  const pmid = String(value || '').trim().replace(/^pmid:/i, '');
  return /^\d{1,12}$/.test(pmid) ? pmid : '';
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function mapICitePublication(raw) {
  const pmid = normalizePmid(raw?.pmid);
  if (!pmid) return null;
  const citationCount = finiteOrNull(raw?.citation_count);
  const doi = String(raw?.doi || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase() || undefined;
  return {
    pmid,
    doi,
    ...(citationCount !== null ? { citationCount, citationCountKnown: true } : {}),
    iciteMetrics: {
      relativeCitationRatio: finiteOrNull(raw?.relative_citation_ratio),
      nihPercentile: finiteOrNull(raw?.nih_percentile),
      approximatePotentialToTranslate: finiteOrNull(raw?.apt),
      isClinical: typeof raw?.is_clinical === 'boolean' ? raw.is_clinical : null,
      provisional: typeof raw?.provisional === 'boolean' ? raw.provisional : null,
    },
  };
}

export async function fetchICiteMetrics(papersOrPmids) {
  const pmids = [...new Set((papersOrPmids || []).map(item => normalizePmid(item?.pmid ?? item)).filter(Boolean))]
    .slice(0, MAX_PMIDS);
  if (!PAPER_API_BASE || pmids.length === 0) return {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(`${PAPER_API_BASE}/enrich/icite`);
    url.searchParams.set('pmids', pmids.join(','));
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return {};
    const payload = await response.json();
    return Object.fromEntries((payload?.data || []).map(mapICitePublication).filter(Boolean).map(item => [item.pmid, item]));
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

export function mergeICiteEnrichment(papers, metricsByPmid) {
  if (!metricsByPmid || Object.keys(metricsByPmid).length === 0) return papers;
  return papers.map(paper => {
    const pmid = normalizePmid(paper?.pmid);
    const enrichment = pmid ? metricsByPmid[pmid] : null;
    if (!enrichment) return paper;
    const merged = PaperBuilder.merge(paper, enrichment, 'icite');
    // Same identity discipline as mergeOpenAlexEnrichment: a no-op merge
    // (record present but nothing actually differs) must still return the
    // original object, or memo(PaperCard)'s IntersectionObserver gets torn
    // down and rebuilt for a card that didn't really change.
    return paperFieldsEqual(merged, paper) ? paper : merged;
  });
}
