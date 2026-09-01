/**
 * What kind of paper an interaction document id names.
 *
 * Liked/saved rows are keyed by the feed's `paper.id`, which is an OpenAlex
 * work, an arXiv id (new or pre-2007), a DOI, or an ADS bibcode. Hydration
 * has to send each one to the provider that can actually answer for it.
 */
const OPENALEX = /^(?:openalex:)?W\d+$/i;
const ARXIV_NEW = /^\d{4}\.\d{4,5}(?:v\d+)?$/i;
const ARXIV_OLD = /^[a-z][a-z-]+\/\d{7}(?:v\d+)?$/i;
const DOI = /^(?:doi:)?10\.\d{4,9}\/\S+$/i;

export function classifyInteractionPaperId(id) {
  const text = typeof id === 'string' ? id.trim() : '';
  if (!text) return { kind: 'unknown', value: '' };

  if (OPENALEX.test(text)) {
    return { kind: 'openalex', value: text.replace(/^openalex:/i, '') };
  }
  if (/^arxiv:/i.test(text)) {
    const value = text.replace(/^arxiv:/i, '').trim();
    return value ? { kind: 'arxiv', value } : { kind: 'unknown', value: '' };
  }
  if (ARXIV_NEW.test(text) || ARXIV_OLD.test(text)) {
    return { kind: 'arxiv', value: text };
  }
  if (DOI.test(text) || /^doi:/i.test(text)) {
    const value = text.replace(/^doi:/i, '').replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
    return value ? { kind: 'doi', value } : { kind: 'unknown', value: '' };
  }
  if (/^ads:/i.test(text)) {
    return { kind: 'ads', value: text.replace(/^ads:/i, '') };
  }
  return { kind: 'unknown', value: text };
}
