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

/**
 * @param {object|string} author  an author entry as the card holds it
 * @param {string} paperId        the paper's id, for the arXiv fallback
 * @param {{ publicMode?: boolean }} options
 * @returns {string} a router path, or '' when there is nothing to open
 */
export function authorExplorerPath(author, paperId, { publicMode = false } = {}) {
  const name = authorDisplayName(author);
  const authorId = openAlexAuthorId(author);
  if (publicMode) {
    return getPublicEntityPath('author', authorId || name, { includeName: Boolean(authorId), name }) || '';
  }
  if (authorId) {
    return `/explorer/author/${authorId}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
  }
  if (!name) return '';
  const arxivId = String(paperId || '').replace(/^arxiv:/i, '');
  return `/explorer/author/${encodeURIComponent(name)}?arxivId=${encodeURIComponent(arxivId)}`;
}
