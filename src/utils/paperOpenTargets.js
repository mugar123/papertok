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
 */
import { isTrustedInlinePdfUrl, safeExternalUrl } from './externalUrl.js';

function arxivPdfUrl(arxivId) {
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
export function pdfLinksForPaper(paper) {
  const direct = safeExternalUrl(paper?.pdfUrl);
  const arxiv = arxivPdfUrl(paper?.arxivId);
  return {
    fullTextUrl: direct || arxiv,
    embedUrl: [direct, arxiv].find(url => url && isTrustedInlinePdfUrl(url)) || '',
  };
}

/**
 * Los destinos de texto completo de un paper, del mejor al peor.
 *
 * `mode` dice quién abre: `inline` es el visor de la app, y solo lo reciben los
 * hosts que dejan enmarcar su PDF; `external`, una pestaña nueva.
 */
export function openTargetsForPaper(paper, openCopy = null) {
  const candidates = [
    openCopy?.pdfUrl,
    openCopy?.landingPageUrl,
    paper?.openAccessPdfUrl,
    arxivPdfUrl(paper?.arxivId),
    paper?.pdfUrl,
    paper?.landingPageUrl,
  ];

  const seen = new Set();
  const targets = [];
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
export function openFirstTarget(targets, { inline, external }) {
  for (const target of targets) {
    if (target.mode === 'inline' ? inline(target) : external(target.url)) return true;
  }
  return false;
}
