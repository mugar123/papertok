import { normalizeCitationDoi } from './citationGraph.js';

export const RELATED_SHEET_CLOSE_MS = 180;
export const RELATED_PAPER_HANDOFF_MS = 210;
export const RELATED_CARD_CLOSE_MS = 220;
export const RELATED_TRANSITION_FALLBACK_GRACE_MS = 80;

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeArxivId(value) {
  return normalizeText(value)
    .replace(/^arxiv:/, '')
    .replace(/v\d+$/, '');
}

function normalizeOpenAlexId(value) {
  return normalizeText(value)
    .split('/')
    .pop()
    .replace(/^openalex:/, '');
}

export function getRelatedPaperIdentity(paper) {
  const stableIdentifiers = [
    ['doi', normalizeCitationDoi(paper?.doi)],
    ['arxiv', normalizeArxivId(paper?.arxivId)],
    ['openalex', normalizeOpenAlexId(paper?.openAlexId)],
    ['semantic-scholar', normalizeText(paper?.semanticScholarId)],
    ['id', normalizeText(paper?.id)],
  ];
  const stableIdentifier = stableIdentifiers.find(([, value]) => value);
  if (stableIdentifier) return `${stableIdentifier[0]}:${stableIdentifier[1]}`;

  const title = normalizeText(paper?.title).replace(/\s+/g, ' ');
  return title ? `title:${title}` : '';
}

export function buildRelatedPaperEntries(papers) {
  const occurrences = new Map();
  return (Array.isArray(papers) ? papers : []).map((paper, index) => {
    const identity = getRelatedPaperIdentity(paper) || `index:${index}`;
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return {
      paper,
      identity,
      key: `${identity}#${occurrence}`,
    };
  });
}

export function getRelatedTransitionDuration(durationMs, prefersReducedMotion = false) {
  const duration = Math.max(0, Number(durationMs) || 0);
  return prefersReducedMotion ? 0 : duration;
}

export function getRelatedTransitionFallbackDelay(durationMs, prefersReducedMotion = false) {
  const duration = getRelatedTransitionDuration(durationMs, prefersReducedMotion);
  return duration === 0 ? 0 : duration + RELATED_TRANSITION_FALLBACK_GRACE_MS;
}

export function getRelatedTransitionAction(animationName) {
  if (animationName === 'relatedSheetOut' || animationName === 'relatedCardOut') return 'close';
  if (animationName === 'relatedSheetToCard') return 'select';
  return null;
}
