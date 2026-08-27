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
