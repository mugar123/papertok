/**
 * Which generation of per-account state the app is on.
 *
 * `App` keys the provider tree that holds account-scoped state on this, so that
 * everything below it is rebuilt when the reader becomes SOMEBODY ELSE. The
 * whole point of this module is the case that must NOT rebuild it: the account
 * merely becoming KNOWN.
 *
 * The tree used to be keyed on `user?.uid || 'signed-out'` directly. `user` is
 * null on the first render of every load (`AuthContext.jsx`, `useState(null)`)
 * and only becomes the session when `onAuthStateChanged` answers, so on every
 * signed-in cold load that key flipped once and React destroyed and rebuilt the
 * subtree — `<Routes>` and the page inside it included — in the middle of that
 * page's first paint. Measured on an entity page (2026-09-07, real session,
 * production build, 1280×900): the hero reached 93% of its entrance with the
 * tab strip already 68.1px down, then snapped BACK to the skeleton in one frame
 * (tabs 278.1 → 210), replayed its fade from 0.35 and restarted its height
 * settle from currentTime 0. The only backwards movement on the page, and a
 * reader cannot read a reversal as loading — only as a fault.
 *
 * So the key is a generation counter instead of the account itself:
 *
 *   - Before the session is known, nothing moves. There is no account to be
 *     wrong about yet.
 *   - The FIRST account a load resolves to is ADOPTED at the generation it is
 *     already on. This is the flip that used to remount, and it is the whole
 *     fix: a load that goes null → somebody keeps one tree.
 *   - Any LATER change of account advances the generation, which is what the
 *     key was for (`e507856`, "isolate recommendation state"). Signing out is
 *     such a change; so is switching accounts.
 *
 * `authLoading` matters because it is raised again on every auth emission,
 * including a token refresh, while `user` stays. "Known" therefore means *there
 * is a user*, or *auth has finished and says there is none* — never merely
 * "loading is false right now".
 *
 * **What this shifts onto everything below the key.** A remount used to
 * re-initialise per-account state for free, so a `useState(Boolean(user))` in a
 * provider was a correct reading of the account. It no longer is: on a cold
 * load that runs with `user` still null. Any state below this key that reads the
 * account at MOUNT time has to handle the account arriving later instead
 * (`FollowingContext` and `EmailNotificationsContext` raise their loading gates
 * in an effect for exactly this reason).
 */

/** The account name a signed-out reader scopes to. */
export const SIGNED_OUT_ACCOUNT = 'signed-out';

/** Before any load has resolved an account. `generation` is what keys the tree. */
export const INITIAL_ACCOUNT_SCOPE = Object.freeze({ account: null, generation: 0 });

/**
 * The scope after this render's auth state.
 *
 * Returns `previous` BY IDENTITY when nothing changed, so a caller can compare
 * with `!==` and only adjust state when it must.
 *
 * @param {{account: string|null, generation: number}} previous
 * @param {{uid?: string|null, authLoading?: boolean}} auth
 * @returns {{account: string|null, generation: number}}
 */
export function nextAccountScope(previous, { uid, authLoading } = {}) {
  const scope = previous || INITIAL_ACCOUNT_SCOPE;
  const account = uid || '';
  // A token refresh raises `authLoading` again with the user still in hand;
  // that is not the session becoming unknown.
  const sessionKnown = Boolean(account) || authLoading === false;
  if (!sessionKnown) return scope;

  const resolved = account || SIGNED_OUT_ACCOUNT;
  if (scope.account === resolved) return scope;
  // Adopted, not switched to: the first account a load resolves to inherits the
  // generation the tree already has, so nothing below it is rebuilt.
  if (scope.account === null) return { account: resolved, generation: scope.generation };
  return { account: resolved, generation: scope.generation + 1 };
}

/**
 * The key itself. The account is deliberately NOT in it: including it would put
 * the adoption back in the key and undo the fix. The generation already changes
 * on every real account change, which is the only thing the key must react to.
 *
 * @param {{generation: number}} scope
 * @returns {string}
 */
export function accountScopeKey(scope) {
  return `account-${(scope || INITIAL_ACCOUNT_SCOPE).generation}`;
}
