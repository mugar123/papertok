import { PaperBuilder } from '../services/PaperBuilder.js';

export function getOpenAlexEnrichmentId(paperOrId) {
  const value = typeof paperOrId === 'string' ? paperOrId : paperOrId?.id;
  if (!value) return '';
  const rawId = value.startsWith('arxiv:') ? value.split(':')[1] : value;
  const normalized = rawId.replace(/v\d+$/, '');
  return /^W\d+$/i.test(normalized) ? `openalex:${normalized}` : normalized;
}

export function mergeOpenAlexEnrichment(papers, enrichmentById) {
  if (!enrichmentById || Object.keys(enrichmentById).length === 0) return papers;

  return papers.map((paper) => {
    const enrichment = enrichmentById[getOpenAlexEnrichmentId(paper)];
    return enrichment ? PaperBuilder.merge(paper, enrichment, 'openalex') : paper;
  });
}

export async function waitForInitialEnrichment(enrichmentPromise, timeoutMs = 2500) {
  let timeoutId;
  try {
    return await Promise.race([
      enrichmentPromise,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
