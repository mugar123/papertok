/**
 * The links that were minted while the fragment was the route.
 *
 * PaperTok was a HashRouter from its first commit, so every link it ever put
 * on a clipboard, into a share sheet or into a notification email has the shape
 * `https://papertok.app/#/public/paper/<key>`. `src/main.jsx` mounts a
 * BrowserRouter now: the router reads `location.pathname`, and a fragment is
 * back to meaning a place on the page. Nothing changed about the links, and the
 * plan's first constraint is that none of them may die.
 *
 * One hop brings one home. A fragment never reaches the server, so no rewrite
 * can read it; the app, booting at whatever path it was served — `/` included,
 * now that index.html is the app again — finds the fragment still sitting
 * there and turns it into the route it always named. (A second hop existed
 * while `/` was a marketing landing served from its own document: its inline
 * gate forwarded `#/…` to `/feed` with the fragment intact. The landing was
 * withdrawn; the translation below was always the half that did the work.)
 *
 * It runs once, before React, and rewrites the entry in place — see
 * `applyLegacyHashRoute`. The alternative, letting the app mount at `/feed` and
 * then navigating, would paint a feed the visitor did not ask for and leave
 * that feed in the history behind the page they did.
 *
 * NOT every fragment is a route. `#main-content` is the skip link's target;
 * `#/` is the only prefix that ever meant a route, and it is the only one this
 * module answers to.
 */

/** Where `#/` itself used to go. Named rather than left as `/`: the app's own
    catch-all would bounce `/` here anyway, and doing it in the rewrite keeps
    the feed to the single address every share link and canonical tag uses. */
export const LEGACY_ROOT_ROUTE = '/feed';

/**
 * The real route a legacy fragment names, or `null` when the fragment is not
 * one. `search` is the document's own query — the half a HashRouter never saw,
 * and how every `?probe=` cache-buster in `scripts/diagnostics` reaches the
 * app — carried over only when the route does not name a query of its own.
 */
export function routeFromLegacyHash({ search = '', hash = '' } = {}) {
  if (typeof hash !== 'string' || !hash.startsWith('#/')) return null;

  // A second `#` is a fragment OF the route, not part of it: `#/research#main-content`
  // is the research page scrolled to its content, and the route is `/research`.
  const [route] = hash.slice(1).split('#');

  const queryAt = route.indexOf('?');
  const rawPathname = queryAt >= 0 ? route.slice(0, queryAt) : route;
  const ownQuery = queryAt >= 0 ? route.slice(queryAt) : '';

  // `//evil.com` is a protocol-relative URL the browser would follow off this
  // origin. Collapsing the slashes makes it a path here that matches no route,
  // which is the whole of the defence: a fragment is attacker-supplied in the
  // only sense that matters, since anyone can hand anyone a link.
  //
  // Backslashes FIRST, and that order is the point: the URL parser treats `\`
  // as `/` for http(s), so `#/\\evil.com` survives slash-collapsing untouched
  // and then resolves to `https://evil.com` — measured, not reasoned about.
  // `history.replaceState` would refuse a cross-origin URL and this module
  // would decline in its catch, so the visitor was never actually sent
  // anywhere; but that made the refusal the defence and this line a comment
  // that was not true. A caller who used the returned route for anything other
  // than replaceState would have had no defence at all. No route in this app
  // contains a backslash: ids arrive percent-encoded.
  const pathname = `/${rawPathname.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`;
  if (pathname === '/') return `${LEGACY_ROOT_ROUTE}${ownQuery || (typeof search === 'string' ? search : '')}`;

  const query = ownQuery || (typeof search === 'string' ? search : '');
  return `${pathname}${query}`;
}

/**
 * Rewrites the current entry to the route its fragment names, and answers with
 * that route (or `null` when there was nothing to translate). `replaceState`,
 * not a push: the fragment address must not sit in the history behind the page
 * it named, or a Back press would land on it and translate it all over again.
 *
 * The entry's existing state travels through untouched — on a reload deep in
 * history that object carries react-router's `idx`, which is what
 * `utils/routeDirection.js` reads to tell an arrival from a step back.
 */
export function applyLegacyHashRoute({ history, location } = {}) {
  const route = routeFromLegacyHash(location || {});
  if (!route || !history?.replaceState) return null;
  try {
    history.replaceState(history.state ?? null, '', route);
  } catch {
    // Safari throws SecurityError past ~100 history writes in 30 seconds, the
    // same ceiling `useOverlayHistory.js` and react-router's own history module
    // guard against. Declining leaves the reader where the fragment landed
    // them, which is no worse than not having translated at all; throwing here
    // would take the app down before React ever rendered.
    return null;
  }
  return route;
}
