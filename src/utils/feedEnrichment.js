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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// PaperBuilder.merge always allocates a fresh top-level object (and
// sometimes fresh nested objects/arrays, e.g. `sources`, `iciteMetrics`,
// `openAlex`) even when every value it computes is identical to what the
// paper already had — a re-fetch of the same upstream record is a common
// way to hit this. A reference check (`===`) can't tell that apart from a
// real change, so this walks values instead. Anything it can't confidently
// prove equal (functions, class instances, mismatched shapes) is treated as
// different, so a real change is never mistaken for a no-op and dropped.
export function paperFieldsEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((item, index) => paperFieldsEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length
      && keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && paperFieldsEqual(a[key], b[key]));
  }
  return false;
}

export function mergeOpenAlexEnrichment(papers, enrichmentById) {
  if (!enrichmentById || Object.keys(enrichmentById).length === 0) return papers;

  return papers.map((paper) => {
    const enrichment = enrichmentById[getOpenAlexEnrichmentId(paper)];
    if (!enrichment) return paper;
    const merged = PaperBuilder.merge(paper, enrichment, 'openalex');
    // Identity matters as much as content here: memo(PaperCard) and its
    // IntersectionObserver (PaperCard.jsx:370, keyed on `paper`) only survive
    // a late enrichment pass if a no-op merge hands back the exact same
    // object paper had before, not just a freshly-built lookalike.
    return paperFieldsEqual(merged, paper) ? paper : merged;
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
