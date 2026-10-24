# Working on PaperTok

Keep instructions here when they change a decision an agent could get wrong after reading
the code. Explain the situation, required action and reason. Keep directory maps, setup
and command inventories in existing documentation. Remove rules whose constraint no longer
exists. Read the nearest applicable `AGENTS.md` before editing; nested rules may not have
been loaded when the session started at the root. Worker configuration also follows
[the Worker decisions](worker/AGENTS.md), even when the configuration is edited at the root.

## Scope and skills

- Name new branches `<author-name>/feature-name`, using the current author's given
  name in lowercase ASCII (for example, `nicolas/feature-name` for Nicolas), unless
  the user requests another name. Resolve the author from the user's stated identity
  or Git author configuration; ask if neither identifies them.
- Keep one objective per change. Preserve user-owned work; exclude unrelated formatting,
  lint fixes, refactors and imports. Findings outside the task are observations, not
  permission to repair the repository.
- Challenge a proposed design when a concrete tradeoff or simpler solution warrants it.
  Continue authorized work without asking again for routine, reversible decisions.
- Before handing off any repository change, choose and run checks with
  [Repo QA](.agents/skills/repo-qa/SKILL.md), and have the final diff, including untracked
  files, reviewed with [Review](.agents/skills/review/SKILL.md) in a context that did not
  write it (the `reviewer` subagent in Claude Code). Loading a skill is not evidence that
  it ran; report who reviewed and what they found.
- For bugs, failures or regressions, use [Diagnosing bugs](.agents/skills/diagnosing-bugs/SKILL.md).
  For user-facing copy, comments, documentation or PR text, use
  [Unslop](.agents/skills/unslop/SKILL.md). When the user corrects the same kind of mistake
  twice, use [Correct](.agents/skills/correct/SKILL.md) to turn it into a check. Read only
  skills relevant to the task. If discovery omits a required skill, open its linked source
  rather than reconstructing it from memory.

## Ownership and complexity

- Take the first option that completes the task: leave out what nothing requires, reuse the
  existing owner, use the platform or an installed dependency's API, and only then write the
  smallest clear code for what remains. A shorter diff that hides a bug or removes a
  boundary is not simpler.
- Before adding a helper, validator, state or dependency, inspect its existing owner and
  consumers. Add a layer only for a current requirement; fewer lines do not justify moving
  behavior into the wrong layer or hiding it in a dense expression.
- Validate untrusted input at ingestion and normalize provider data into the existing paper
  contract. Do not create competing paper shapes or repeatedly repair the same payload in
  components. A missing internal invariant needs a fix at its owner, not guards at callers.
- Keep one owner for a fact. Derive values from existing route, query or application state
  unless they have an independent interaction or lifetime. Do not maintain synchronized
  copies, speculative registries, compatibility bridges or unused configuration.
- A fallback must represent an expected unavailable source or optional field. Do not turn
  invalid credentials, malformed required data or unexpected errors into success, invented
  metadata or unexplained empty results. Preserve useful degraded states and retry paths.
- Fix lint findings at their cause. Do not evade a rule with renames, wrappers, suppressions
  or weaker assertions, timeouts, baselines or file coverage. A disable directive is only for a
  constraint a dependency or platform imposes: one line, with the reason after `--`.
- Do not edit `eslint.config.ts`, `knip.jsonc`, tsconfig files, CI workflows or
  `.claude/settings.json` to make a check pass. Changing what a gate enforces needs the user's
  explicit approval, and a new rule lands with every existing violation fixed.

## Rules the checks enforce

| Rule | Enforced by |
| --- | --- |
| Tests call the code and assert its result; they never match source text | [lint: no-restricted-syntax] in `src`, `worker` and `proxy` tests |
| Application code does not launder types with `as unknown as` | [lint: no-restricted-syntax] |
| A promise is awaited, or its rejection is handled | [lint: @typescript-eslint/no-floating-promises], [lint: @typescript-eslint/no-misused-promises] |
| The frontend never imports Worker or proxy code; the Worker never imports UI or client SDKs | [lint: no-restricted-imports] |
| Every disable directive states its reason, and an unused one fails | [lint: @eslint-community/eslint-comments/require-description] |
| Focus stays visible: no `outline: none` without a recorded replacement, no ring in `--brand-orange`, the global ring outside every `@layer` | [lint: papertok/no-focus-ring-removal], [lint: papertok/no-brand-orange-focus-ring], [lint: papertok/focus-ring-unlayered] |
| Text and focus tokens keep WCAG contrast in both themes; every colour token has a dark value | [lint: papertok/token-contrast], [lint: papertok/dark-theme-parity] |
| Every `var(--token)` in a stylesheet resolves, and stylesheets load nothing from other origins | [lint: papertok/defined-custom-properties], [lint: papertok/no-external-css-urls] |
| Overlays come from `src/components/ui`; patterned buttons appear only where design.md allows | [lint: no-restricted-syntax], [lint: papertok/patterned-buttons] |
| A context is created in a component-free `.ts` module, never beside a component | [lint: no-restricted-syntax] in `.tsx` files |
| No unused files, exports or dependencies | knip in `npm run check` |
| Generated bindings and local secrets are not hand-edited; editing a gate file asks first | `.claude/settings.json` permission rules |

Everything else in these files is enforced by review. Classes of mistakes that keep recurring
without a check are listed in [the papercuts ledger](docs/agents/papercuts.md).

## Scientific and product decisions

- Unknown citations, abstracts, review status, concepts and open-access links stay unknown.
  A confirmed zero is different from missing data. Repository availability does not prove
  peer review. AI output must not imply access to full text when only an abstract was supplied.
- Prefer DOI, arXiv, OpenAlex or provider identifiers over title matching. Persist canonical
  taxonomy and entity IDs rather than display labels. Enrichment adds evidence; it must not
  replace original arXiv categories with OpenAlex concepts.
- Merge card metadata before display, or expose enrichment explicitly. Liking or saving a
  paper must not change its visible scientific metadata. Apply enrichment consistently
  across feed batches.
- Provider timeouts, quotas and downtime must leave usable papers from other sources
  available. Keep deadlines and retries bounded; do not multiply requests to mask an outage.
- The interface, generated explanations, emails and share pages are English-only. Comments,
  documentation, commits and PR text are English too. Preserve original paper content and
  mark its language when known. Legacy `language: 'es'` requests remain accepted and ignored.

## Identity, secrets and costs

- Scope signed-in preferences, interactions, follows, seen papers and reading history to
  the Firebase user ID. Clear or replace in-memory state on account changes as well as
  namespacing storage. Guest onboarding choices are a temporary bridge: clear them when
  adopted or when an existing onboarded profile loads, so they cannot seed another account.
- Provider credentials belong in Cloudflare secrets, never frontend code or `VITE_*`.
  Firebase web configuration and the PostHog project token are deliberately public;
  neither grants authorization.
  Verify Firebase identity for protected user-specific operations and enforce ownership
  in Firestore rules or the Worker, not just by hiding UI.
- Personal responses must not share global cache keys. Canonicalize keys from the parameters
  actually sent upstream. Reserve paid-provider budgets atomically; do not replace shared
  ledgers with process memory or non-atomic read-then-write counters.
- Analytics has two levels (`src/services/analyticsService.ts`). Anonymous is the default
  and needs no permission, so it stays cookieless and within the event allowlist: no paper
  titles, entity IDs, search text, interests, account identifiers or unsanitized URLs.
  Detailed analytics may identify the account, record sessions and send which paper or search,
  but only after an explicit opt-in. Route new identifying fields through the `detail` schema
  type so the anonymous level drops them, and update `privacy.html` when either level changes.

## Accessibility and interface

WCAG 2.2 AA is an acceptance criterion for every UI task. Read [the design system](design.md)
and the applicable frontend instructions before designing, implementing or reviewing UI.
Keep native semantics, keyboard operation,
visible focus, accessible names, labeled errors and announced status changes. Reuse the
existing Base UI components for focus, dismissal and nesting; do not hand-roll overlays.
Preserve reduced-motion support, contrast and target sizes. Automatic checks alone do not
establish conformance; report manual evidence and anything not verified.

## Verification and delivery

- Check signed-in behavior locally against the Firebase emulators, not a real account
  ([setup](worker/README.md#local-testing)). They sign in a disposable test user and keep
  Firestore writes off production. Worker routes that require identity reject emulator
  tokens, so report those flows as unverified; check guest flows with `npm run dev`.
- Add or modify tests only for behavior introduced or fixed by this task. Assert observable
  results through the existing test tools, using colocated `*.test.ts` files; do not pin
  the implementation's own constants or add production APIs just to satisfy a mock.
- Update existing contract and development documentation when adding routes, environment
  variables, providers or persistence. Historical investigation notes do not override code
  or current product decisions.
- Never retain harness, E2E runner, fixture, environment, build, manifest, lockfile or logging
  changes merely to make local verification pass. Remove temporary changes before finishing
  and report what was removed. Do not commit or push local workarounds without explicit
  authorization. Ask before retaining a workaround as a production change, or when scope
  of a test or tooling change is unclear.
- Do not hand-edit generated output or local secrets. Keep disposable probes outside the
  checkout and mention any provider quota consumed in the delivery response.
- Frontend publication uses Vercel; the Cloudflare Worker is deployed separately. A contract
  change must keep both sides compatible and verify both deployment paths before publication.
  A local build or Worker dry-run does not prove a production deployment happened.
