import { normalizeCitationDoi } from './citationGraph.js';


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

