import type { Paper } from '../models/Paper.ts';

export interface OpenTarget { mode: 'external' | 'inline'; url: string; }

/**
 * Dónde se abre un paper, en orden de preferencia y en un solo sitio.
 *
 * La cascada vivía dentro del manejador del botón como una escalera de `return`
 * tempranos, y esa forma escondía el fallo: cada rama daba por abierto lo que
 * había intentado abrir. `openExternalUrl` devuelve `false` cuando la URL no
 * pasa la puerta de salida -- y devolvía `false` a menudo, porque los catálogos
 * entregan enlaces `http://` que la app no abre -- pero nadie miraba ese valor.
 * El botón prometía la versión abierta, el `return` se ejecutaba igual, y el
 * clic no hacía nada: ni pestaña, ni visor, ni aviso.
 *
 * Con la lista explícita, el manejador recorre los destinos hasta que uno abre
 * de verdad. Un enlace roto pasa al siguiente en vez de terminar el intento.
 *
 * El DOI no está aquí a propósito. Es el enlace de rendirse -- lleva a la
 * página del editor, que para un paper de pago es justo el muro que la copia
 * abierta esquivaba -- así que lo pone el manejador al final, después de haber
 * agotado el texto completo y de haber preguntado por una copia libre.
 *
 * The reader's library link is here, and first: it is the version of record
 * through the resolver of a university that subscribes to it. It always opens
 * in a new tab, where the reader may have to sign in with the university:
 * through the library's resolver (Alma), or at the publisher, which an SFX
 * link reaches directly.
 */
import { isTrustedInlinePdfUrl, safeExternalUrl } from './externalUrl.ts';
import { isAIReadablePdfUrl } from './aiExplanationAccess.ts';

function arxivPdfUrl(arxivId: unknown) {
  const id = String(arxivId || '').trim();
  // El prefijo fija el origen: lo que venga en el id solo puede ser ruta,
  // consulta o fragmento, y `safeExternalUrl` descarta lo que ni siquiera
  // parsee.
  return id ? safeExternalUrl(`https://arxiv.org/pdf/${id}`) : '';
}

/**
 * Los dos enlaces al PDF de un paper, que no son el mismo: `fullTextUrl` es el
 * mejor PDF que existe, y `embedUrl` el que además se deja enmarcar.
 *
 * El visor los tenía fundidos en uno, así que un PDF alojado donde prohíben el
 * iframe se anunciaba como «no hay PDF de acceso abierto disponible» -- y lo
 * había, a un clic de distancia.
 */
export function pdfLinksForPaper(paper: Partial<Paper> | null | undefined) {
  const direct = safeExternalUrl(paper?.pdfUrl);
  const arxiv = arxivPdfUrl(paper?.arxivId);
  return {
    fullTextUrl: direct || arxiv,
    embedUrl: [direct, arxiv].find(url => url && isTrustedInlinePdfUrl(url)) || '',
    // El que el Worker accede a reenviar (`GET /pdf`) para que el visor táctil
    // dibuje las páginas él mismo: los hosts que ya leen las rutas de IA.
    relaySourceUrl: [direct, arxiv].find(url => url && isAIReadablePdfUrl(url)) || '',
  };
}

/**
 * La URL del reenvío del Worker para un PDF, o '' si no hay Worker o el PDF
 * no es de un host que el Worker acepte.
 */
export function pdfRelayUrl(sourceUrl: string, apiBase: unknown) {
  const base = String(apiBase || '').replace(/\/$/, '');
  if (!base || !sourceUrl || !isAIReadablePdfUrl(sourceUrl)) return '';
  return `${base}/pdf?url=${encodeURIComponent(sourceUrl)}`;
}

/**
 * Los destinos de texto completo de un paper, del mejor al peor.
 *
 * `mode` dice quién abre: `inline` es el visor de la app, y solo lo reciben los
 * hosts que dejan enmarcar su PDF; `external`, una pestaña nueva.
 * `institutionAccess` is the answer from `findInstitutionAccess`.
 */
export function openTargetsForPaper(paper: Partial<Paper> | null | undefined, openCopy: Partial<Paper> | null = null, institutionAccess: { status?: string; url?: string | null } | null = null): OpenTarget[] {
  // `findInstitutionAccess` only ever hands over an entitlement with a safe link.
  const libraryUrl = institutionAccess?.status === 'entitled' ? institutionAccess.url : '';
  const candidates = [
    openCopy?.pdfUrl,
    openCopy?.landingPageUrl,
    paper?.openAccessPdfUrl,
    arxivPdfUrl(paper?.arxivId),
    paper?.pdfUrl,
    paper?.landingPageUrl,
  ];

  const seen = new Set(libraryUrl ? [libraryUrl] : []);
  const targets: OpenTarget[] = libraryUrl ? [{ mode: 'external', url: libraryUrl }] : [];
  for (const candidate of candidates) {
    const url = safeExternalUrl(candidate);
    // Una misma URL llega por dos campos más veces de las que parece, y
    // reintentarla no la arregla: solo gasta un turno de la cascada.
    if (!url || seen.has(url)) continue;
    seen.add(url);
    targets.push({ mode: isTrustedInlinePdfUrl(url) ? 'inline' : 'external', url });
  }
  return targets;
}

/**
 * Abre el primer destino que responda. Devuelve si alguno lo hizo, que es el
 * dato que faltaba: el manejador necesita saber cuándo seguir buscando.
 */
export function openFirstTarget(targets: OpenTarget[], { inline, external }: { inline: (target: OpenTarget) => unknown; external: (url: string) => unknown }) {
  for (const target of targets) {
    if (target.mode === 'inline' ? inline(target) : external(target.url)) return true;
  }
  return false;
}
