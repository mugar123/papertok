/**
 * Where a search result sends you.
 *
 * The palette pointed papers at `/explorer/paper/<id>`, and there has never
 * been such a route. `/explorer/:type/:id` mounts the entity explorer, which
 * knows about authors, institutions, projects, sources and topics — so a paper
 * id went to `getEntityById('paper', …)`, whose endpoint table has no entry for
 * papers and falls through to the authors endpoint. OpenAlex answered 404 for a
 * work id asked of `/authors`, and the palette's most obvious action ended on
 * "Entity not found".
 *
 * A paper's canonical address in this app is the public paper page — the same
 * URL the share button hands out. Routing there means the destination is one
 * the app declares, and one the reader can send to somebody else.
 */
import { getPublicPaperPath } from './publicNavigation.js';

/**
 * The path for a paper, and the paper itself to hand over with it.
 *
 * `PublicPaperPage` renders a paper passed through router state immediately and
 * treats the network load as an upgrade rather than a gate — it is what keeps
 * that page alive when arXiv rate-limits. The palette has already fetched the
 * whole paper to draw the row, so there is no reason to make the reader wait
 * for it to be fetched a second time.
 *
 * The key is built from a DOI or an arXiv id, which is what the public page can
 * resolve. A work with neither has no address in this app at all — it cannot be
 * shared or linked — so rather than a dead row it goes to the full search page,
 * carrying the query, where the same paper opens in an overlay that needs no
 * identifier.
 */
export function searchPaperDestination(paper, query = '') {
  const path = getPublicPaperPath(paper);
  if (path) return { path, state: { paper } };

  const term = String(query || paper?.title || '').trim();
  return {
    path: term ? `/search?q=${encodeURIComponent(term)}` : '/search',
    state: null,
  };
}
