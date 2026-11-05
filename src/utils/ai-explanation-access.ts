const UNAVAILABLE_ABSTRACTS = new Set([
  'no abstract available.',
  'no summary available.',
  'resumen no disponible.',
  'el resumen no esta disponible en crossref.',
]);

function normalizedAbstract(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasUsableAIAbstract(value: unknown) {
  const normalized = normalizedAbstract(value);
  return Boolean(normalized) && !UNAVAILABLE_ABSTRACTS.has(normalized);
}

export function isAIReadablePdfUrl(value: string | URL | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      host === 'arxiv.org'
      || host === 'export.arxiv.org'
      || host === 'europepmc.org'
      || host.endsWith('.europepmc.org')
      || host === 'www.ebi.ac.uk'
      || host === 'pmc.ncbi.nlm.nih.gov'
      || host.endsWith('.ncbi.nlm.nih.gov')
      || host === 'zenodo.org'
      || host === 'ntrs.nasa.gov'
    );
  } catch {
    return false;
  }
}

/**
 * The Zenodo record a DOI Zenodo minted names (`10.5281/zenodo.<id>`), as the
 * record's page, or '' for any other DOI. Zenodo files a deposit's PDF under its
 * own name, so the record is what can be asked for (`fetchPaperPdfBytes`).
 */
export function zenodoRecordUrl(doi: unknown) {
  const id = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.5281\/zenodo\.(\d{1,12})$/i.exec(String(doi || '').trim())?.[1];
  return id ? `https://zenodo.org/records/${id}` : '';
}
