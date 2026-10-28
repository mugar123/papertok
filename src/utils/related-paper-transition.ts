import type { Paper } from '../models/paper.ts';

import { normalizeCitationDoi } from './citation-graph.ts';


function normalizeText(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeArxivId(value: unknown) {
  return normalizeText(value)
    .replace(/^arxiv:/, '')
    .replace(/v\d+$/, '');
}

function normalizeOpenAlexId(value: unknown) {
  return normalizeText(value)
    .split('/')
    .pop()!
    .replace(/^openalex:/, '');
}

export function getRelatedPaperIdentity(paper: Partial<Paper> | null | undefined) {
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

/**
 * The trail after centring on `next`. A citation graph has cycles, so a paper
 * already on the trail cuts it back to that paper instead of appearing twice.
 */
export function stepRelatedPaperTrail<T extends Partial<Paper>>(trail: T[], next: T) {
  const identity = getRelatedPaperIdentity(next);
  const seen = trail.findIndex(item => getRelatedPaperIdentity(item) === identity);
  return seen >= 0 ? trail.slice(0, seen + 1) : [...trail, next];
}

export function buildRelatedPaperEntries<T extends Partial<Paper>>(papers: T[] | null | undefined) {
  const occurrences = new Map<string, number>();
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

