import type { Paper } from '../models/paper.ts';

import { PaperBuilder } from './paper-builder.ts';
import { paperFieldsEqual } from '../utils/feed-enrichment.ts';

// iCite's answers as fields of a PubMed paper, for the browser and the
// Worker's paper store alike.

export function normalizePmid(value: unknown) {
  const pmid = String(value || '').trim().replace(/^pmid:/i, '');
  return /^\d{1,12}$/.test(pmid) ? pmid : '';
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function mapICitePublication(raw: Record<string, unknown> | null): (Partial<Paper> & { pmid: string }) | null {
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

export function mergeICiteEnrichment(papers: Paper[], metricsByPmid: Record<string, Partial<Paper>>) {
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
