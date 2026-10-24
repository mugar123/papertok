# Papercuts

Classes of mistakes that no check enforces yet. Each entry says what gets through and what
would catch it. An entry leaves this file when its check lands; the check is then the record.
Use the [Correct](../../.agents/skills/correct/SKILL.md) skill to work one down.

## Behavior inside components has no test runner

Node does not execute `.tsx`, so logic written inside a component, context or hook that
imports Firebase is untested unless it is moved into a `.ts` module. These behaviors were
held only by tests that matched source text, which were removed on 2026-10-24; nothing
checks them now:

- `rewritePaper`'s stream and saved-copy handling beyond `rewriteKeeping`: a stream error is
  not overwritten by a later `done`, end of stream before any section is an error, a broken
  connection keeps the received sections as incomplete, Try again asks the server to replace a
  truncated cached rewrite, a saved copy opens without a Worker request, a failed read stops
  with `AI_SAVED_SUMMARY_READ_FAILED` and is not kept over the copy, and the cache clears on an
  account change. Needs the Worker fetch, saved-summary store and API base passed in.
- Analytics `surface` values: a value missing from the sanitizer's allowlist is dropped without
  warning. Event names are typed; surfaces are not.
- `SaveToListModal` writes only from `handleCreateList` and `handleSave`.
- `fetchLibraryRecords` fans out through `mapWithConcurrency`, not an unbounded `Promise.all`.
- The onboarding flow refuses more than `USER_PREFERENCES_MAX` interests.
- `firebase.ts` registers the Firestore stall recovery at module scope.
- The feed retries a `FEED_LOAD_FAILED` first page once; `completeOnboarding` sets the flag only
  after `confirmOnboardingWrite` resolves. The decisions are tested in `src/context/`; the
  ordering inside the context is not.
- The router keeps `useTransitions={false}` and keys the provider tree on `accountScopeKey`.
- Every route `app.tsx` declares is matched by the `vercel.json` rewrite and normalizes to a
  named analytics path; the sitemap and `robots.txt` agree on protected routes.
- Landmarks: each routed page has one `<main>` and one `<h1>`, every `<nav>` has a name, and
  the skip link targets a focusable `#main-content`.

→ Move the decision into a `.ts` module next to the component and test it there, as
`src/components/search/recent-search-owner.ts` does. A component render test runner would cover
what cannot be moved.

## Defensive guards against values the types rule out

`@typescript-eslint/no-unnecessary-condition` reports about 1,300 optional chains and checks
on values whose type is never missing. Many are the "guard at every caller" AGENTS.md forbids,
but some protect provider data that is typed more optimistically than it arrives.

→ Enable `noUncheckedIndexedAccess` first (about 400 type errors), fix the provider types at
their boundary, then enable the rule.

## Source files over 1,000 lines

Eleven files exceed 1,000 lines; the largest are `worker/email-notifications.ts`,
`entity-explorer.tsx` and `paper-card.tsx`. Agents add to the nearest large file.

→ A `max-lines` rule once those files are split by owner.

## Display labels used as keys

AGENTS.md says to persist canonical IDs, not labels. Nothing detects a `Set` of titles or a
comparison against display copy.

## Review is attested, not evidenced

The `pr-body` check requires a Review section, but cannot tell whether a review ran or what it
covered.

## Authorized decisions are not checked

Nothing checks that a PR containing a decision that needs authorization lists it, or that the
named person approved it. The `pr-body` check does not require the section.

## Workflow actions pinned to a commit

Every `uses:` in `.github/workflows` is pinned to a 40-character SHA today, by convention.

→ zizmor or actionlint in CI.
