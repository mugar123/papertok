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
    };
  }
  return records;
}
