/**
 * Readers for the efetch XML the Worker relays with every PubMed search
 * (`pubmedData.efetch`). They take a parsed XML document, the browser's
 * `DOMParser` output in the app, so they can be tested under Node against the
 * same selectors.
 */

import { orderMeshDescriptors } from './meshCheckTags.js';

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * The article's own abstract: the sections under Article/Abstract, each with
 * its label as PubMed prints it ("BACKGROUND: …"). A publisher translation is
 * a sibling OtherAbstract with sections of its own, and reading every
 * AbstractText in the article appended it to the English text (PMID 42775314
 * ended in Serbian; audit 2026-09-23). No sections, no abstract.
 */
export function pubmedAbstractText(article) {
  const sections = Array.from(article?.querySelectorAll?.('Abstract > AbstractText') || []);
  return sections
    .map((section) => {
      const text = collapseWhitespace(section.textContent);
      if (!text) return '';
      const label = collapseWhitespace(section.getAttribute('Label'));
      return label ? `${label}: ${text}` : text;
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * The article's MeSH subjects for the card: its major topics first (a heading
 * is major when its descriptor or any of its qualifiers says MajorTopicYN="Y"),
 * without the check tags every record carries.
 */
export function pubmedSubjects(article) {
  const headings = Array.from(article?.querySelectorAll?.('MeshHeadingList > MeshHeading') || []);
  return orderMeshDescriptors(headings.map((heading) => {
    const descriptor = heading.querySelector('DescriptorName');
    const qualifiers = Array.from(heading.querySelectorAll('QualifierName'));
    return {
      name: collapseWhitespace(descriptor?.textContent),
      major: descriptor?.getAttribute('MajorTopicYN') === 'Y'
        || qualifiers.some(qualifier => qualifier.getAttribute('MajorTopicYN') === 'Y'),
    };
  }));
}

const ORCID = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\s*$/i;

/**
 * The article's authors as the record names them: `name` in PubMed's own
 * "Surname INITIALS" (what esummary gave the card), the full name, the first
 * affiliation and the ORCID when the record has one. The card used to keep
 * esummary's "Li WN" and nothing else, which left the explorer only a name to
 * guess the person from (audit 2026-09-23, issue 4).
 */
export function pubmedAuthors(article) {
  const authors = Array.from(article?.querySelectorAll?.('Article > AuthorList > Author') || []);
  return authors.flatMap((author) => {
    const collective = collapseWhitespace(author.querySelector('CollectiveName')?.textContent);
    const lastName = collapseWhitespace(author.querySelector('LastName')?.textContent);
    const foreName = collapseWhitespace(author.querySelector('ForeName')?.textContent);
    const initials = collapseWhitespace(author.querySelector('Initials')?.textContent);
    const name = collective || [lastName, initials].filter(Boolean).join(' ');
    if (!name) return [];
    const orcid = Array.from(author.querySelectorAll('Identifier'))
      .filter(identifier => identifier.getAttribute('Source') === 'ORCID')
      .map(identifier => collapseWhitespace(identifier.textContent).match(ORCID)?.[1]?.toUpperCase())
      .find(Boolean);
    const affiliation = collapseWhitespace(author.querySelector('AffiliationInfo > Affiliation')?.textContent);
    return [{
      name,
      fullName: collective || [foreName, lastName].filter(Boolean).join(' '),
      ...(orcid ? { orcid } : {}),
      ...(affiliation ? { affiliation } : {}),
    }];
  });
}

const comparableName = (value) => collapseWhitespace(value).toLowerCase();

/**
 * The card's authors with the record's identifiers laid over them: by
 * position when the two lists line up, by name otherwise (esummary can drop a
 * collective author). The card's own names are kept, so nothing it shows
 * changes; an author the record does not name is left as it was.
 */
export function mergePubmedAuthors(cardAuthors, recordAuthors) {
  const card = Array.isArray(cardAuthors) ? cardAuthors : [];
  const record = Array.isArray(recordAuthors) ? recordAuthors : [];
  if (record.length === 0) return card;
  const byPosition = card.length === record.length
    && card.every((author, index) => comparableName(author?.name) === comparableName(record[index].name));
  return card.map((author, index) => {
    if (!author || typeof author !== 'object') return author;
    const match = byPosition
      ? record[index]
      : record.find(candidate => comparableName(candidate.name) === comparableName(author.name));
    if (!match) return author;
    const identifiers = { ...match };
    delete identifiers.name;
    return { ...identifiers, ...author };
  });
}

/**
 * What the adapter merges into each mapped paper, keyed as the adapter keys
 * papers (`pmid:<id>`). The first PMID in an article is its own; the ones in
 * CommentsCorrections come after it.
 */
export function readPubmedEfetch(xmlDoc) {
  const records = {};
  for (const article of Array.from(xmlDoc?.querySelectorAll?.('PubmedArticle') || [])) {
    const pmid = collapseWhitespace(article.querySelector('PMID')?.textContent);
    if (!pmid) continue;
    records[`pmid:${pmid}`] = {
      abstract: pubmedAbstractText(article),
      categories: pubmedSubjects(article),
      authors: pubmedAuthors(article),
    };
  }
  return records;
}
