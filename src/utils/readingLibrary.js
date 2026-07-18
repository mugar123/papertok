function authorName(author) {
  if (typeof author === 'string') return author.trim();
  return author?.name?.trim() || '';
}

export function serializeLibraryPaper(paper = {}) {
  return {
    id: paper.id || paper.arxivId || paper.doi || '',
    title: paper.title || 'Paper sin titulo',
    authors: (paper.authors || []).slice(0, 20),
    primaryCategory: paper.primaryCategory || paper.categories?.[0] || '',
    categories: paper.categories || (paper.primaryCategory ? [paper.primaryCategory] : []),
    published: paper.published || paper.publicationDate || '',
    year: paper.year || (paper.published ? new Date(paper.published).getFullYear() : null),
    summary: paper.summary?.substring(0, 1000) || '',
    arxivId: paper.arxivId || '',
    doi: paper.doi || '',
    journal: paper.journal || paper.venue || '',
    pdfUrl: paper.pdfUrl || paper.openAccessPdfUrl || '',
    landingPageUrl: paper.landingPageUrl || paper.url || '',
  };
}

function cleanBibValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function citationKey(paper, index = 0) {
  const firstAuthor = authorName(paper.authors?.[0]).split(/\s+/).pop() || 'Paper';
  const year = paper.year || (paper.published ? new Date(paper.published).getFullYear() : 'nd');
  const titleWord = (paper.title || '').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).find(word => word.length > 3) || 'Research';
  return `${firstAuthor}${year}${titleWord}${index || ''}`.replace(/[^a-zA-Z0-9]/g, '');
}

export function papersToBibTeX(papers = []) {
  return papers.map((paper, index) => {
    const fields = [
      `  title = {${cleanBibValue(paper.title)}},`,
      paper.authors?.length ? `  author = {${paper.authors.map(authorName).filter(Boolean).map(cleanBibValue).join(' and ')}},` : '',
      paper.year || paper.published ? `  year = {${paper.year || new Date(paper.published).getFullYear()}},` : '',
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

export function papersToRIS(papers = []) {
  return papers.map((paper) => {
    const lines = ['TY  - JOUR', `TI  - ${String(paper.title || '').replace(/\s+/g, ' ').trim()}`];
    (paper.authors || []).map(authorName).filter(Boolean).forEach(author => lines.push(`AU  - ${author}`));
    if (paper.year || paper.published) lines.push(`PY  - ${paper.year || new Date(paper.published).getFullYear()}`);
    if (paper.journal) lines.push(`JO  - ${paper.journal}`);
    if (paper.doi) lines.push(`DO  - ${paper.doi}`);
    if (paper.landingPageUrl) lines.push(`UR  - ${paper.landingPageUrl}`);
    if (paper.summary) lines.push(`AB  - ${paper.summary.replace(/\s+/g, ' ').trim()}`);
    lines.push('ER  -');
    return lines.join('\n');
  }).join('\n\n');
}

export function downloadCitationFile(papers, format, filename = 'papertok') {
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
