const lastSegment = (value) => String(value || '').split('/').pop();

/**
 * What a search-palette row hands the Explorer through router state.
 *
 * The rows already hold the entity they point at, and the page can paint a
 * hero from it before the full record answers — the way `PublicPaperPage`
 * paints a paper handed over by the palette. Measured before this: an author
 * picked from the palette arrived as a skeleton and collapsed 113px when the
 * record came, 156px on a phone while the page was still sliding in.
 *
 * Returns null for a row the page cannot paint, or for one the page would
 * only be worse off being born with. Projects are never handed over: their
 * skeleton reserves a summary box and two stat cells that a search row does
 * not carry, and a live hero born from a name alone would grow by more than
 * the skeleton does when OpenAIRE answers. A local topic row is refused too:
 * `searchLocalTopics` (openAlexService.js) marks its rows `_localTopic: true`
 * and they come first in the results, so the page can already resolve a
 * richer entity for itself from CATEGORIES than the search row carries — the
 * page can resolve the row better than the handover would. An institution
 * row missing its counts is refused as well: `rankInstitutionsByProminence`
 * (openAlexService.js) can leave ROR candidates unenriched, and a hero born
 * without `works_count` or `cited_by_count` would be poorer than what the
 * skeleton's stats grid already reserves.
 */
export function handoverFromSearchRow(type, row) {
  if (!row || !row.display_name) return null;
  if (type === 'author') {
    return {
      id: row.id,
      display_name: row.display_name,
      works_count: row.works_count ?? null,
      cited_by_count: row.cited_by_count ?? null,
      summary_stats: row.h_index != null ? { h_index: row.h_index } : null,
      orcid: row.orcid || null,
      x_concepts: Array.isArray(row.concepts) ? row.concepts : [],
      institution: row.institution || null,
    };
  }
  if (type === 'institution') {
    if (row.works_count == null || row.cited_by_count == null) return null;
    return { ...row };
  }
  if (type === 'topic') {
    if (row._localTopic) return null;
    return { id: row.id, display_name: row.display_name, works_count: row.works_count ?? null };
  }
  return null;
}

/**
 * The entity a page may be born with: the one handed over in router state,
 * only when it is the entity the route names. `state` is `location.state`;
 * a route reached by any other link, or a stale state after a reload, gets
 * null and loads as it always did.
 */
export function handedEntityFor(type, id, state) {
  const handed = state?.entity;
  if (!handed || !handed.display_name || typeof id !== 'string') return null;
  if (state.entityType !== type) return null;
  const routeId = decodeURIComponent(id);
  if (type === 'author') {
    const orcidInRoute = routeId.match(/orcid\.org\/([0-9X-]+)/i)?.[1];
    if (orcidInRoute) {
      return handed.orcid && String(handed.orcid).includes(orcidInRoute) ? handed : null;
    }
  }
  return lastSegment(handed.id) === lastSegment(routeId) ? handed : null;
}
