interface CitationDownload { href: string; download: string; click(): void; remove(): void }
declare const document: { createElement(tag: 'a'): CitationDownload; body: { appendChild(link: CitationDownload): unknown } };

import type { Paper } from '../models/paper.ts';
import { storedClassification } from '../models/paper.ts';
import { hasUsableAIAbstract } from './ai-explanation-access.ts';

function authorName(author: Paper['authors'][number] | undefined) {
  if (typeof author === 'string') return author.trim();
  return author?.name?.trim() || '';
}

/**
 * How much of a paper a stored copy keeps. The summary used to be cut at
 * 1,000 characters, short of most abstracts, so the paper page could never
 * show the text the reader had seen in the feed from the copy alone and took
 * the provider's — a different text, when the provider was a different one.
 * The copy lives in the interaction document's `paper` map, which Firestore
 * bounds only as a map, so a whole abstract costs nothing to keep. The old
 * cap is remembered so a copy written under it can be told from a whole one.
 */
export const STORED_SUMMARY_CAP = 4000;
export const LEGACY_STORED_SUMMARY_CAP = 1000;
export const STORED_AUTHOR_CAP = 20;

/**
 * The text a stored copy or an interaction keeps of a paper: its `summary`
 * where one was built, else its `abstract`, all a corpus paper carries.
 */
export function abstractExcerpt(paper: Partial<Paper> = {}, chars = 500) {
  return (paper.summary || paper.abstract || '').substring(0, chars);
}

export function serializeLibraryPaper(paper: Partial<Paper> & { venue?: string; url?: string } = {}) {
  return {
    id: paper.id || paper.arxivId || paper.doi || '',
    title: typeof paper.title === 'string' ? paper.title : '',
    authors: (paper.authors || []).slice(0, STORED_AUTHOR_CAP),
    ...storedClassification(paper),
    published: paper.published || paper.publicationDate || '',
    year: paper.year || (paper.published ? new Date(paper.published).getFullYear() : null),
    summary: abstractExcerpt(paper, STORED_SUMMARY_CAP),
    arxivId: paper.arxivId || '',
    doi: paper.doi || '',
    journal: paper.journal || paper.venue || '',
    pdfUrl: paper.pdfUrl || paper.openAccessPdfUrl || '',
    landingPageUrl: paper.landingPageUrl || paper.url || '',
  };
}

function cleanBibValue(value: unknown) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function citationKey(paper: Partial<Paper>, index = 0) {
  const firstAuthor = authorName(paper.authors?.[0]).split(/\s+/).pop() || 'Paper';
  const year = paper.year || (paper.published ? new Date(paper.published).getFullYear() : 'nd');
  const titleWord = (paper.title || '').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).find(word => word.length > 3) || 'Research';
  return `${firstAuthor}${year}${titleWord}${index || ''}`.replace(/[^a-zA-Z0-9]/g, '');
}

export function papersToBibTeX(papers: Partial<Paper>[] = []) {
  return papers.map((paper, index) => {
    const fields = [
      `  title = {${cleanBibValue(paper.title)}},`,
      paper.authors?.length ? `  author = {${paper.authors.map(authorName).filter(Boolean).map(cleanBibValue).join(' and ')}},` : '',
      paper.year || paper.published ? `  year = {${paper.year || new Date(paper.published!).getFullYear()}},` : '',
      paper.journal ? `  journal = {${cleanBibValue(paper.journal)}},` : '',
      paper.doi ? `  doi = {${cleanBibValue(paper.doi)}},` : '',
      paper.arxivId ? `  eprint = {${cleanBibValue(paper.arxivId)}},` : '',
      paper.arxivId ? '  archivePrefix = {arXiv},' : '',
      paper.landingPageUrl ? `  url = {${cleanBibValue(paper.landingPageUrl)}},` : '',
    ].filter(Boolean);
    fields[fields.length - 1] = fields[fields.length - 1].replace(/,$/, '');
    return `@article{${citationKey(paper, index)},\n${fields.join('\n')}\n}`;
  }).join('\n\n');
}

export function papersToRIS(papers: Partial<Paper>[] = []) {
  return papers.map((paper) => {
    const lines = ['TY  - JOUR', `TI  - ${String(paper.title || '').replace(/\s+/g, ' ').trim()}`];
    (paper.authors || []).map(authorName).filter(Boolean).forEach(author => lines.push(`AU  - ${author}`));
    if (paper.year || paper.published) lines.push(`PY  - ${paper.year || new Date(paper.published!).getFullYear()}`);
    if (paper.journal) lines.push(`JO  - ${paper.journal}`);
    if (paper.doi) lines.push(`DO  - ${paper.doi}`);
    if (paper.landingPageUrl) lines.push(`UR  - ${paper.landingPageUrl}`);
    const abstract = [paper.summary, paper.abstract].find(hasUsableAIAbstract);
    if (abstract) lines.push(`AB  - ${abstract.replace(/\s+/g, ' ').trim()}`);
    lines.push('ER  -');
    return lines.join('\n');
  }).join('\n\n');
}

export function downloadCitationFile(papers: Partial<Paper>[], format: string, filename = 'papertok') {
  const isBibTeX = format === 'bibtex';
  const content = isBibTeX ? papersToBibTeX(papers) : papersToRIS(papers);
  const blob = new Blob([content], { type: isBibTeX ? 'application/x-bibtex;charset=utf-8' : 'application/x-research-info-systems;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.${isBibTeX ? 'bib' : 'ris'}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
