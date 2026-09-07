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
  assert.match(code, /<HashRouter useTransitions=\{false\}>/, 'navigation must not be a React transition');
  assert.doesNotMatch(code, /<HashRouter>/, 'a bare <HashRouter> falls back to transitions');
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
