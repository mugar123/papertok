declare const window: { open(url: string, target: string, features: string): unknown };

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

function isHostOrSubdomain(hostname: string, allowedHost: string) {
  return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
}

export function safeExternalUrl(value: unknown) {
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
export function safeCatalogUrl(value: unknown) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    if (url.protocol === 'http:') url.protocol = 'https:';
    return safeExternalUrl(url.toString());
  } catch {
    return '';
  }
}

const DOI_RESOLVER = /^https?:\/\/(?:dx\.)?doi\.org\//i;

/**
 * The doi.org link of a DOI, or '' when the value is not DOI-shaped.
 *
 * A DOI may hold any printable character, and doi.org decodes the path of a
 * link once, so each character that means something else in a URL travels
 * percent-encoded, once. `encodeURI` does that for spaces, `<`, `>`, `"`, `%`
 * and the rest, but leaves `#` and `?`, which end the path where they stand:
 * doi.org would be asked for `…3.0.co;2-` in place of `…3.0.co;2-#`. A `.` or
 * `..` segment is the exception no encoding covers: the URL parser resolves
 * it, written as `%2E` too, before the request leaves.
 *
 * A value is read in one of two ways:
 * - a DOI given as itself is read as written. `10.1234/a%3Fb` has `%3F` among
 *   its characters and links to `…/a%253Fb`;
 * - a resolver link is a URL, read as doi.org reads it: the DOI is its path,
 *   decoded once, and a `?` or `#` ends the path, so a query or fragment is
 *   not part of the DOI (`https://doi.org/10.1000/1?noredirect` is 10.1000/1).
 *   `https://doi.org/10.1234/a%3Fb` is 10.1234/a?b, so this function's own
 *   link comes back unchanged. A path that does not decode (a `%` that
 *   starts no escape, or escapes that are not UTF-8) is read as written.
 *   Space around the DOI is not part of it, decoded or not.
 * A provider that writes the resolver before the DOI's characters unencoded,
 * as OpenAlex does (`…/3.0.co;2-#`), has written no URL: its adapter strips
 * the resolver and hands the bare DOI on.
 */
export function safeDoiUrl(doi: unknown) {
  const text = String(doi || '').trim();
  let normalized = text.replace(DOI_RESOLVER, '');
  if (normalized !== text) {
    normalized = normalized.split(/[?#]/, 1)[0];
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // A `%` that starts no escape, or escapes that are not UTF-8: the path
      // is read as written.
    }
    normalized = normalized.trim();
  }
  return /^10\.\d{4,9}\/.+/.test(normalized)
    ? `https://doi.org/${encodeURI(normalized).replace(/[#?]/g, character => encodeURIComponent(character))}`
    : '';
}

export function isTrustedInlinePdfUrl(value: unknown) {
  const safeUrl = safeExternalUrl(value);
  if (!safeUrl) return false;
  const url = new URL(safeUrl);
  return [...INLINE_PDF_HOSTS].some(host => isHostOrSubdomain(url.hostname.toLowerCase(), host));
}

export function openExternalUrl(value: unknown) {
  const safeUrl = safeExternalUrl(value);
  if (!safeUrl || typeof window === 'undefined') return false;
  window.open(safeUrl, '_blank', 'noopener,noreferrer');
  return true;
}
