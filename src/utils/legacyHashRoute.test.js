import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromLegacyHash, applyLegacyHashRoute } from './legacyHashRoute.js';

/**
 * These cover the links that already exist out in the world. The app was a
 * HashRouter from its first commit, so `papertok.app/#/public/paper/<key>` is
 * the shape of every link ever shared from it, every link the Worker's
 * notification emails carry, and every bookmark anyone made. The router stopped
 * reading the fragment; nothing about those links changed.
 */

test('a fragment that is a route becomes the route', () => {
  assert.equal(routeFromLegacyHash({ hash: '#/public/paper/abc' }), '/public/paper/abc');
  assert.equal(routeFromLegacyHash({ hash: '#/research' }), '/research');
  assert.equal(routeFromLegacyHash({ hash: '#/explorer/author/A5023888391' }), '/explorer/author/A5023888391');
});

test('the old feed address is the new feed address', () => {
  // `#/` was the feed. `/` is the landing now, and an app that redirected
  // itself there would be handed back to the marketing page on the next
  // reload.
  assert.equal(routeFromLegacyHash({ hash: '#/' }), '/feed');
});

test('a fragment that is not a route is left alone', () => {
  // `#main-content` is the skip link's target on both the landing and the app.
  // Translating it would eject a keyboard user to a page they never asked for,
  // which is the exact bug the skip link's own click handler exists to prevent.
  assert.equal(routeFromLegacyHash({ hash: '#main-content' }), null);
  assert.equal(routeFromLegacyHash({ hash: '#section-2' }), null);
  assert.equal(routeFromLegacyHash({ hash: '' }), null);
  assert.equal(routeFromLegacyHash({}), null);
  assert.equal(routeFromLegacyHash({ hash: '#' }), null);
});

test('the query travels: the route’s own wins, and the document’s is kept when it has none', () => {
  // Under a HashRouter the whole route, query included, lived after the `#`.
  assert.equal(routeFromLegacyHash({ hash: '#/search?q=cats' }), '/search?q=cats');
  // ...while a query in front of the `#` was invisible to the router and is
  // how every `?probe=` cache-buster in scripts/diagnostics reaches the app.
  assert.equal(routeFromLegacyHash({ hash: '#/lists', search: '?probe=7' }), '/lists?probe=7');
  // Both: the route named its own, so the document's is not merged into it.
  assert.equal(routeFromLegacyHash({ hash: '#/lists?a=1', search: '?probe=7' }), '/lists?a=1');
});

test('a fragment can never send the visitor off-site', () => {
  // `//evil.com` is a protocol-relative URL the browser would follow off the
  // origin. Collapsed, it is a path on this site that matches no route.
  assert.equal(routeFromLegacyHash({ hash: '#//evil.com' }), '/evil.com');
  assert.equal(routeFromLegacyHash({ hash: '#///evil.com/x' }), '/evil.com/x');
  // The same trick with backslashes, which the URL parser treats as slashes
  // for http(s). Asserted as an ORIGIN rather than as a string, because the
  // string is not what is dangerous: `/\\evil.com` looks like a path and
  // resolves to `https://evil.com`.
  for (const hash of ['#/\\\\evil.com', '#/\\\\/evil.com', '#//\\\\evil.com', '#/\\\\\\\\evil.com/x']) {
    const route = routeFromLegacyHash({ hash });
    assert.equal(
      new URL(route, 'https://papertok.app').origin,
      'https://papertok.app',
      `${hash} translated to ${route}, which leaves the origin`,
    );
  }
  // A second `#` is a fragment of the route, not part of it.
  assert.equal(routeFromLegacyHash({ hash: '#/research#main-content' }), '/research');
});

test('applying it rewrites the entry in place, once, before anything reads the location', () => {
  const calls = [];
  const history = {
    state: { idx: 3, usr: null, key: 'abc' },
    replaceState: (state, unused, url) => calls.push([state, url]),
  };
  const location = { pathname: '/feed', search: '', hash: '#/public/paper/abc' };

  assert.equal(applyLegacyHashRoute({ history, location }), '/public/paper/abc');
  assert.equal(calls.length, 1);
  // replace, not push: the fragment address must not sit in the history behind
  // the page it named, or Back would translate it all over again.
  assert.deepEqual(calls[0][0], { idx: 3, usr: null, key: 'abc' }, 'the entry keeps its state');
  assert.equal(calls[0][1], '/public/paper/abc');
});

test('applying it to a location that carries no route does nothing at all', () => {
  const calls = [];
  const history = { state: null, replaceState: (...args) => calls.push(args) };
  assert.equal(applyLegacyHashRoute({
    history,
    location: { pathname: '/feed', search: '', hash: '#main-content' },
  }), null);
  assert.equal(calls.length, 0);
});

test('a history that refuses the rewrite is not a boot failure', () => {
  // Safari throws SecurityError past ~100 history writes in 30 s. Declining
  // leaves the reader on the feed with a stale fragment, which is the old
  // behaviour; throwing here would take the whole app down before React runs.
  const history = { state: null, replaceState: () => { throw new Error('SecurityError'); } };
  assert.equal(applyLegacyHashRoute({
    history,
    location: { pathname: '/feed', search: '', hash: '#/research' },
  }), null);
});
