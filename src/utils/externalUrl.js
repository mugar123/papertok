const INLINE_PDF_HOSTS = new Set([
  'arxiv.org',
  'export.arxiv.org',
  'europepmc.org',
  'www.ebi.ac.uk',
  'pmc.ncbi.nlm.nih.gov',
]);

function isHostOrSubdomain(hostname, allowedHost) {
  return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
}

export function safeExternalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function safeDoiUrl(doi) {
  const normalized = String(doi || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return /^10\.\d{4,9}\/.+/.test(normalized)
    ? `https://doi.org/${encodeURI(normalized)}`
    : '';
}

export function isTrustedInlinePdfUrl(value) {
  const safeUrl = safeExternalUrl(value);
  if (!safeUrl) return false;
  const url = new URL(safeUrl);
  return [...INLINE_PDF_HOSTS].some(host => isHostOrSubdomain(url.hostname.toLowerCase(), host));
}

export function openExternalUrl(value) {
  const safeUrl = safeExternalUrl(value);
  if (!safeUrl || typeof window === 'undefined') return false;
  window.open(safeUrl, '_blank', 'noopener,noreferrer');
  return true;
}
