import { PaperBuilder } from '../services/PaperBuilder.js';

export function getOpenAlexEnrichmentId(paperOrId) {
  const candidates = typeof paperOrId === 'string'
    ? [paperOrId]
    : [paperOrId?.id, paperOrId?.arxivId];

  for (const value of candidates) {
    if (!value) continue;
    const rawId = /^(?:arxiv|openalex):/i.test(value) ? value.split(':')[1] : value;
    const normalized = rawId.replace(/v\d+$/, '');
    if (/^W\d+$/i.test(normalized)) return `openalex:${normalized}`;
    if (/^\d{4}\.\d{4,5}$/.test(normalized) || /^[a-z][a-z.-]+\/\d{7}$/i.test(normalized)) {
      return normalized;
    }
  }

  return '';
}

export function needsOpenAlexEnrichment(paper) {
  const id = getOpenAlexEnrichmentId(paper);
  if (!id || !(/^(?:openalex:)?W\d+$/i.test(id) || /^\d{4}\.\d{4,5}$/.test(id) || /^[a-z][a-z.-]+\/\d{7}$/i.test(id))) {
    return false;
  }

  const sources = paper?.sources || {};
  return sources.primary !== 'openalex' && !(sources.enrichedBy || []).includes('openalex');
}

export function takeFeedPage(papers, pageSize = 15) {
  const safeSize = Number.isFinite(pageSize) ? Math.max(0, Math.floor(pageSize)) : 15;
  return (Array.isArray(papers) ? papers : []).slice(0, safeSize);
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
