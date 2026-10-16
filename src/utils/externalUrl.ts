// Enmarcable, no «académico». Un host entra aquí solo si sirve el PDF sin
// prohibir el iframe, y eso se comprueba con las cabeceras, no por reputación.
// Medido el 2026-08-29: arXiv responde `application/pdf` sin `X-Frame-Options`,
// mientras que `pmc.ncbi.nlm.nih.gov` y `europepmc.org` mandan
// `X-Frame-Options: DENY` -- PMC además redirige su `/pdf/` a HTML -- y
// `www.ebi.ac.uk` es la API REST, que devuelve XML y no tiene PDF que servir.
// Los tres estaban en la lista, así que sus copias abrían un recuadro gris:
// el iframe bloqueado dispara `onLoad` igual que uno bueno, de modo que el
// visor daba por cargado lo que el navegador acababa de rechazar.
const INLINE_PDF_HOSTS = new Set([
  'arxiv.org',
  'export.arxiv.org',
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

/**
 * Una URL de catálogo lista para abrirse: la misma puerta que `safeExternalUrl`,
 * pero subiendo a HTTPS lo que llega en claro.
 *
 * Los catálogos abiertos siguen entregando enlaces `http://` -- repositorios
 * institucionales, `hdl.handle.net`, hasta `dx.doi.org` -- y la app solo abre
 * `https:`, así que cada uno de ellos era un botón que no hacía nada. Se sube
 * aquí, al entrar el dato, y no en la puerta de salida: `safeExternalUrl` es la
 * comprobación de «esto se puede entregar a `window.open`» y debe seguir
 * diciendo que no a lo que no es HTTPS.
 *
 * Sobre la muestra medida el 2026-08-29, cuatro de cada seis de esos hosts
 * sirven HTTPS. Los otros dos no responden por HTTPS y acaban en una pestaña
 * con error del navegador, que sigue siendo mejor que un clic mudo: dice que
 * la fuente está rota, no la app.
 */
export function safeCatalogUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    if (url.protocol === 'http:') url.protocol = 'https:';
    return safeExternalUrl(url.toString());
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
