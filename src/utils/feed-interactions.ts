import type { Paper } from '../models/paper.ts';

export const SEMANTIC_PROFILE_POSITIVE_CAP = 24;

/**
 * Liked+saved IDs used to build OpenAlex concept weights. Unbounded, this
 * fan-out raced the first feed page for every paper the account had ever
 * kept. The ranking still sees the rest through category affinities on the
 * aggregate; only the semantic overlay is capped.
 */
export function selectSemanticProfilePositiveIds(liked: unknown[] = [], saved: unknown[] = [], cap = SEMANTIC_PROFILE_POSITIVE_CAP) {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : SEMANTIC_PROFILE_POSITIVE_CAP;
  const ids: string[] = [];
  if (limit === 0) return ids;
  const seen = new Set<string>();
  const interleaved = Array.from({ length: Math.max(liked.length, saved.length) }, (_, index) => [liked[index], saved[index]]).flat();
  for (const value of interleaved) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

export function dedupeInteractionPapers<T extends Pick<Partial<Paper>, 'id'>>(papers: T[] = []) {
  const uniquePapers = new Map<string, T>();

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
export function definedFields<T extends Record<string, unknown>>(fields: T = {} as T) {
  const defined: Partial<T> = {};

  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) defined[name as keyof T] = value as T[keyof T];
  }

  return defined;
}
