import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE test: the router is mounted in main.jsx, which node cannot run.
 *
 * React Router 7 wraps every navigation's state update in
 * `React.startTransition`. A transition renders in the background, sliced and
 * at low priority, and the per-frame work of the feed starves it: measured on
 * the tab bar (headless Chromium, mobile emulation, CPU ×4), a tap on
 * Following changed nothing on screen for 699 ms with the chunk warm — no
 * underline, no exit — because both read `useLocation()`. Synchronous, the
 * exit started 11 ms after the tap. The prop is what keeps it synchronous.
 */
test('SOURCE: the router updates its location synchronously, so a tab tap is acknowledged on the next frame', async () => {
  const code = stripComments(await read('./main.jsx'));
  assert.match(code, /<BrowserRouter useTransitions=\{false\}>/, 'navigation must not be a React transition');
  assert.doesNotMatch(code, /<BrowserRouter>/, 'a bare <BrowserRouter> falls back to transitions');
});

/**
 * SOURCE test: the router is mounted in main.jsx, which node cannot run.
 *
 * Every route in this app used to live in the URL fragment, because nothing
 * on the server knew about `/following`. vercel.json rewrites `/feed` and
 * every other non-file path to index.html now — so a real path reaches the
 * app and the fragment is free to go back to meaning "a place on this page".
 * (`/` briefly belonged to a marketing landing served from its own document;
 * the landing was withdrawn and index.html is the app again, so `/` reaches
 * the same bundle as every other path.)
 *
 * The router therefore reads `window.location.pathname`. No `basename`: the
 * site is served from the domain root (`BASE_PATH` in vite.config.js), and a
 * basename that disagreed with the server would match nothing at all.
 */
test('SOURCE: the router reads the path, not the fragment', async () => {
  const code = stripComments(await read('./main.jsx'));
  assert.match(
    code,
    /import \{ BrowserRouter \} from 'react-router-dom'/,
    'main.jsx must mount the router that reads the pathname',
  );
  assert.doesNotMatch(code, /HashRouter/, 'no HashRouter may be left mounted or imported');
  assert.doesNotMatch(code, /basename=/, 'the site is served from the domain root');
});

/**
 * SOURCE test: `App` mounts the routes, which node cannot run.
 *
 * The feed is `/feed`, and `/` only redirects there. A page routed AT `/` —
 * or a redirect to it from inside the app — would give the feed two
 * addresses, one of which is the one every share link, canonical tag and
 * service-worker warm-up (public/sw-html-warm.js) does not use.
 *
 * `/` used to reach the feed through the catch-all, which sent every
 * unmatched path there too, so a broken link landed on a working page without
 * a word (audit 2026-09-23, issue 12). The redirect is its own route now, and
 * the catch-all is the not-found page.
 */
test('SOURCE: the feed lives at /feed, / redirects there, and the catch-all is the not-found page', async () => {
  const code = stripComments(await read('./App.jsx'));

  assert.match(code, /path="\/feed"/, 'the feed route must be /feed');
  assert.doesNotMatch(code, /\n\s*path="\/"\n/, 'no page may be routed at "/"');
  assert.match(
    code,
    /<Route path="\/" element=\{<Navigate to="\/feed" replace \/>\} \/>/,
    'the bare domain must land on the feed',
  );
  assert.match(
    code,
    /<Route\s+path="\*"\s+element=\{\s*<PageTransition>\s*<NotFoundPage \/>/,
    'an undeclared path must say it does not exist',
  );
  assert.doesNotMatch(
    code,
    /<Navigate\s+to="\/"/,
    'no redirect inside the app may target "/": the feed has one address, /feed',
  );
});

/**
 * SOURCE test: `App` mounts the router, which node cannot run.
 *
 * The account-scoped provider tree wraps `<Routes>`, so its key is a remount
 * boundary for every page in the app. Keyed on the account itself
 * (`user?.uid || 'signed-out'`), it flipped once on every signed-in cold load —
 * `user` is null on the first render and only becomes the session when
 * `onAuthStateChanged` answers — and React destroyed and rebuilt the whole tree
 * mid-paint. Measured on an entity page (2026-09-07, real session, production
 * build): the hero reached 93% of its entrance and snapped BACK to the skeleton
 * in one frame, tab strip 278.1 -> 210, replaying its fade and its height
 * settle from zero.
 *
 * The behaviour lives in `utils/accountScope.js` and is tested there over the
 * real auth sequences. This only pins the wiring, because a correct helper that
 * nothing calls fixes nothing.
 */
test('SOURCE: the provider tree is keyed on a generation, not on the account, so resolving a session does not remount the app', async () => {
  const code = stripComments(await read('./App.jsx'));

  const scoped = code.match(/function UserScopedAppContent\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(scoped, 'UserScopedAppContent must still be the thing that carries the key');
  const body = scoped[0];

  assert.doesNotMatch(
    body,
    /key=\{[^}]*\buser\b[^}]*\}/,
    'the key must not be derived from `user` in place — that is the flip that remounted the app',
  );
  assert.match(body, /key=\{accountScopeKey\(/, 'the key comes from accountScopeKey');
  assert.match(body, /nextAccountScope\(/, 'and the generation it carries comes from nextAccountScope');
  assert.match(
    code,
    /import \{[^}]*\bnextAccountScope\b[^}]*\} from '\.\/utils\/accountScope\.js'/,
    'imported from the module that holds the measurement',
  );
});

/**
 * What the remount used to do for free.
 *
 * `useState(Boolean(user))` in a provider below that key was a correct reading
 * of the account only because a remount re-ran it once the account was known.
 * Without the remount it runs on a cold load with `user` still null, so it reads
 * `false` while the uid is on its way — and a `loading: false` with nothing in
 * hand is an unconfirmed absence presented as an answer: "you follow nobody" to
 * an account that follows fifty people, and the gate `FeedContext` waits on
 * before it loads a feed at all.
 *
 * The replacement has to run during render, not in an effect: in an effect the
 * gate closes a commit late, which is a rendered frame of that same wrong
 * answer, and `react-hooks/set-state-in-effect` rejects it besides.
 */
test('SOURCE: the providers below the key re-read the account during render, instead of trusting the mount', async () => {
  const cases = [
    { file: './context/FollowingContext.jsx', id: 'accountId' },
    { file: './context/EmailNotificationsContext.jsx', id: 'userId' },
  ];
  for (const { file, id } of cases) {
    const code = stripComments(await read(file));
    // Two spaces of indent is the component body; an effect's own body is four.
    // Pinning the nesting is the point: the same three lines inside a
    // `useEffect` close the gate a commit late, which is a rendered frame of
    // the wrong answer.
    const reset = new RegExp(
      `\\n {2}if \\(loadingAccount !== ${id}\\) \\{`
      + `\\n {4}setLoadingAccount\\(${id}\\);`
      + `\\n {4}setLoading\\(Boolean\\(${id}\\)\\);`
      + `\\n {2}\\}`,
    );
    assert.match(
      code,
      reset,
      `${file} must re-read the account into its loading gate during render, at the component's own level`,
    );
  }
});
