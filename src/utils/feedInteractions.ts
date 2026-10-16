export const SEMANTIC_PROFILE_POSITIVE_CAP = 24;

/**
 * Liked+saved IDs used to build OpenAlex concept weights. Unbounded, this
 * fan-out raced the first feed page for every paper the account had ever
 * kept. The ranking still sees the rest through category affinities on the
 * aggregate; only the semantic overlay is capped.
 */
export function selectSemanticProfilePositiveIds(liked = [], saved = [], cap = SEMANTIC_PROFILE_POSITIVE_CAP) {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : SEMANTIC_PROFILE_POSITIVE_CAP;
  const ids = [];
  const seen = new Set();
  for (const value of [...liked, ...saved]) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

export function dedupeInteractionPapers(papers = []) {
  const uniquePapers = new Map();

  for (const paper of papers) {
    const paperId = String(paper?.id || '').trim();
    if (!paperId || uniquePapers.has(paperId)) continue;
    uniquePapers.set(paperId, paper);
  }

  return Array.from(uniquePapers.values());
}

/**
 * La misma copia de un paper llega con campos y sin ellos: la del feed trae
 * `primaryCategory`, la guardada en la biblioteca puede no traerla. Firestore
 * no acepta `undefined` en ninguno de sus campos y rechaza la escritura entera
 * — en un `writeBatch`, los skips de todas las tarjetas del gesto, no solo el
 * de la tarjeta incompleta.
 *
 * Se omite el campo en lugar de normalizarlo a '': todas estas escrituras van
 * con `merge: true`, y un '' pisaría la categoría buena que otra interacción ya
 * hubiera dejado escrita.
 *
 * Superficial a propósito. Los valores son sentinelas de Firestore
 * (`increment()`, `deleteField()`) y objetos ya serializados; recorrerlos por
 * dentro los rompería.
 */
export function definedFields(fields = {}) {
  const defined = {};

  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) defined[name] = value;
  }

  return defined;
}
