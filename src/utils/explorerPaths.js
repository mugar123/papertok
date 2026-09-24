import { getPublicEntityPath } from './publicNavigation.js';

/**
 * Where an author on a card opens, and why it matters which door.
 *
 * A card used to send every author to `/explorer/author/<name>?arxivId=…`,
 * even when the paper came from OpenAlex and the author carried their
 * OpenAlex id. The explorer then had to find the author again from the name:
 * fetch the work by its arXiv DOI, match the authorship by name, fetch the
 * profile — three round trips in a row before the hero could paint, and for
 * a paper that is not on arXiv the first two fail before the name search even
 * starts. With the id, the explorer asks for the profile once.
 *
 * The name rides along as `?name=` so the page can paint the masthead the
 * moment it opens, while the profile is on its way.
 */
const OPENALEX_AUTHOR = /(?:^|\/)(A\d+)$/i;

export function openAlexAuthorId(author) {
  const raw = typeof author === 'string' ? '' : String(author?.id || author?.openAlexId || '').trim();
  const match = raw.match(OPENALEX_AUTHOR);
  return match ? match[1].toUpperCase() : '';
}

export function authorDisplayName(author) {
  return String((typeof author === 'string' ? author : author?.name) || '').trim();
}

const ORCID = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i;
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

export function authorOrcid(author) {
  const raw = typeof author === 'string' ? '' : String(author?.orcid || '').trim();
  return raw.match(ORCID)?.[1]?.toUpperCase() || '';
}

/**
 * The paper an author was clicked from, as the explorer can look it up on
 * OpenAlex to find which author entity wrote it: a DOI first, then a PubMed id,
 * then an arXiv id. Takes the paper, or (for older callers) its id.
 */
export function paperReferenceFor(paperOrId) {
  if (paperOrId && typeof paperOrId === 'object') {
    const doi = String(paperOrId.doi || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) return { type: 'doi', value: doi.toLowerCase() };
    const pmid = String(paperOrId.pmid || '').trim();
    if (/^\d+$/.test(pmid)) return { type: 'pmid', value: pmid };
    const arxivId = String(paperOrId.arxivId || '').trim().replace(/^arxiv:/i, '');
    if (ARXIV_ID.test(arxivId)) return { type: 'arxiv', value: arxivId };
    return paperReferenceFor(paperOrId.id);
  }
  const raw = String(paperOrId || '').trim();
  const prefixed = raw.match(/^(doi|pmid|arxiv):(.+)$/i);
  if (prefixed) {
    const type = prefixed[1].toLowerCase();
    if (type === 'doi' && /^10\.\d{4,9}\/\S+$/.test(prefixed[2])) return { type, value: prefixed[2].toLowerCase() };
    if (type === 'pmid' && /^\d+$/.test(prefixed[2])) return { type, value: prefixed[2] };
    if (type === 'arxiv' && ARXIV_ID.test(prefixed[2])) return { type, value: prefixed[2] };
    return null;
  }
  return ARXIV_ID.test(raw) ? { type: 'arxiv', value: raw } : null;
}

// arXiv keeps the `?arxivId=` the explorer has always read (and old links
// carry); a DOI or a PubMed id rides as `?paper=doi:…` / `?paper=pmid:…`.
function paperQuery(reference) {
  if (!reference) return '';
  return reference.type === 'arxiv'
    ? `arxivId=${encodeURIComponent(reference.value)}`
    : `paper=${encodeURIComponent(`${reference.type}:${reference.value}`)}`;
}

function withQuery(path, query) {
  if (!query) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

/**
 * @param {object|string} author  an author entry as the card holds it
 * @param {object|string} paper   the paper the author was clicked from (or its id)
 * @param {{ publicMode?: boolean }} options
 * @returns {string} a router path, or '' when there is nothing to open
 *
 * By identity when the author carries one (OpenAlex id, then ORCID, which the
 * route resolves), otherwise by name with the paper beside it: a name alone
 * is shared by many people ("Wei Zhang" is 11,284 OpenAlex entities), and the
 * paper is what says which one wrote it.
 */
export function authorExplorerPath(author, paper, { publicMode = false } = {}) {
  const name = authorDisplayName(author);
  const identity = openAlexAuthorId(author) || authorOrcid(author);
  const reference = identity ? null : paperReferenceFor(paper);
  if (publicMode) {
    const path = getPublicEntityPath('author', identity || name, { includeName: Boolean(identity), name }) || '';
    return path ? withQuery(path, paperQuery(reference)) : '';
  }
  if (identity) {
    return `/explorer/author/${identity}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
  }
  if (!name) return '';
  return withQuery(`/explorer/author/${encodeURIComponent(name)}`, paperQuery(reference));
}
