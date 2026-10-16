const UNAVAILABLE_ABSTRACTS = new Set([
  'no abstract available.',
  'no summary available.',
  'resumen no disponible.',
  'el resumen no esta disponible en crossref.',
]);

function normalizedAbstract(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasUsableAIAbstract(value) {
  const normalized = normalizedAbstract(value);
  return Boolean(normalized) && !UNAVAILABLE_ABSTRACTS.has(normalized);
}

export function isAIReadablePdfUrl(value) {
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
    );
  } catch {
    return false;
  }
}
