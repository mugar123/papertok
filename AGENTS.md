# PaperTok Agent Guide

This file applies to the whole repository. More specific guidance lives in
`src/AGENTS.md` and `worker/AGENTS.md`; the nearest file takes precedence.

## Project Map

- `src/`: React application, recommendation logic, scientific providers, and tests.
- `worker/`: Cloudflare Worker routes, protected provider calls, AI, and email delivery.
- `public/`: static assets copied by Vite.
- `docs/`: architecture and development documentation.
- `scripts/diagnostics/`: manual provider experiments. These are not part of the test suite.
- `.github/workflows/`: GitHub Pages deployment.

Do not place temporary API probes, generated reports, or lint output in the repository root.

## Commands

Run from the repository root:

```bash
npm ci
npm run dev
npm test
npm run lint
npm run build
npm run check
```

`npm run check` is the expected pre-commit verification. For a narrow change, run the
closest tests first, then the full command before publishing.

## Cross-Cutting Invariants

1. Never expose provider secrets in frontend code or `VITE_*` variables. Browser-visible
   variables are public by definition; protected calls belong in the Worker.
2. Keep user data isolated by Firebase user ID. Do not reintroduce shared browser keys for
   preferences, interactions, follows, seen papers, or reading history.
3. Preserve metadata provenance. Missing citations, abstracts, peer-review status, concepts,
   and open-access links must remain missing rather than being guessed.
4. The interface supports Spanish and English. New user-facing copy must work in both
   languages, including Worker-generated content and cache keys.
5. Provider failure must degrade gracefully. One unavailable scientific API must not leave
   the feed loading forever when another source has usable papers.
6. Paper identity and deduplication should prefer stable DOI, arXiv, OpenAlex, or provider
   identifiers before normalized title fallbacks.
7. Enrichment must not make a paper visibly change because the user liked or saved it.
   Metadata needed for the card should be merged before display or introduced explicitly as
   asynchronous enrichment.

## Accessibility (WCAG 2.2 AA)

Accessibility is an acceptance criterion for every task that touches the UI, not a
separate cleanup. The binding rules live in `docs/ACCESIBILIDAD.md` (in Spanish; the
normative reference is the official W3C text, `docs/WCAG-2.2-original-ingles-W3C-2024-12-12.pdf`
and <https://www.w3.org/TR/WCAG22/>). Read that document before designing, building,
reviewing, or modifying UI. Non-negotiable core, summarized:

1. Target WCAG 2.2 level AA on everything in scope. Do not silently lower the bar; if a
   design request conflicts with accessibility, keep accessibility and surface the conflict.
2. Native semantic HTML first (`button`, `a`, headings, lists, `main`, `nav`, `dialog`).
   Never a `div`/`span` with a click handler as a control. ARIA only where native
   semantics cannot express the truth.
3. Every function must work with keyboard alone: no mouse-only, drag-only, or
   gesture-only paths. Dialogs manage focus (trap, Escape, restore) — reuse
   `Dialog` / `AlertDialog` / `Sheet` / `Drawer` from `src/components/ui/` (shadcn on
   Base UI — the primitive owns the trap, Escape, restore and nesting); do not
   hand-roll focus traps or overlays.
4. Visible focus always; never `outline: none` without an equivalent visible indicator.
5. Contrast: 4.5:1 normal text, 3:1 large text and UI components. Never color as the
   only signal. Respect `prefers-reduced-motion`. Pointer targets ≥ 24×24 CSS px.
6. Every field has a programmatic label; errors are associated to their field and
   announced. Status changes (results, confirmations, failures) reach assistive
   technology via live regions — silent success is a bug.
7. Icon-only controls carry an accessible name (bilingual, like all copy). Informative
   images get useful `alt`; decorative ones get `alt=""`.
8. Mark content-language changes (`lang="en"` on English paper content in the Spanish UI).
9. Do not claim conformance from automatic tools alone (axe, Lighthouse); manual keyboard
   and, where possible, screen-reader verification are part of "done". Record what was
   tested and what was not in the delivery notes (see the evidence matrix in
   `docs/ACCESIBILIDAD.md`).

## Change Discipline

- Write code comments, documentation, commit messages, issue text, and pull request text in
  English. User-facing interface copy remains bilingual in Spanish and English.
- Follow existing React, service, adapter, and utility patterns before adding abstractions.
- Keep tests beside the module they exercise using `*.test.js`.
- Update documentation when adding routes, environment variables, providers, or persistence.
- Do not edit generated `dist/`, `.wrangler/`, local `.env*`, `.claude/`, or dependency files
  except through their normal generators.
- Keep manual API investigations in `scripts/diagnostics/` and label destructive or
  quota-consuming behavior clearly.

## Publishing

- GitHub Pages deploys the frontend from `main`.
- `npx wrangler deploy` publishes the Worker separately.
- A frontend change that depends on a Worker contract is incomplete until both sides are
  compatible and the relevant deployment path has been verified.
