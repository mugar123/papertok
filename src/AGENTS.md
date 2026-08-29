# Frontend and Recommendation Guide

This file applies to `src/`.

## Architecture

- `components/` contains route and feature UI. Keep feature CSS next to its component.
- `context/` owns authenticated, user-scoped application state.
- `services/` talks to scientific providers and maps external data.
- `services/adapters/` implements source-specific paper adapters.
- `utils/` contains deterministic ranking, normalization, navigation, and formatting logic.
- `data/categories.js` is the canonical PaperTok taxonomy and bilingual label source.
- `models/Paper.js` and `services/PaperBuilder.js` define the normalized paper contract.

Prefer a service or adapter for remote data, a utility for pure behavior, and a context only
for genuinely shared state.

## UI Rules

- Use `LanguageContext` for the active language. Do not infer language independently inside
  a component or concatenate translated prefixes with untranslated taxonomy labels.
- Add Spanish and English copy together. Resolve local topics from canonical IDs so stored
  profile data can be rendered in either language.
- Preserve the existing dense, card-based scientific interface and paired component CSS.
- Use Lucide icons already installed in the project.
- Respect reduced-motion preferences when adding transitions.
- Accessibility is an acceptance criterion for every UI change: WCAG 2.2 AA per
  `docs/ACCESIBILIDAD.md` and the Accessibility section of the root `AGENTS.md`. In
  particular: native controls (no clickable `div`s), keyboard operability, visible focus,
  accessible names on icon buttons, announced status changes, and `lang="en"` on English
  paper content.
- Loading, empty, degraded, and retry states are part of the feature, not optional polish.
- Avoid layout shifts when citations, concepts, project badges, or enriched metadata arrive.

## Scientific Data

- Normalize provider payloads before they reach UI components.
- Keep confirmed zero values distinct from unknown values.
- Do not mark preprints or repository records as verified publications without evidence.
- Never replace original arXiv categories with later OpenAlex concepts; concepts enrich the
  taxonomy rather than rewriting it.
- Ensure category and citation enrichment is applied consistently to every feed batch.

## Recommendation and Following

- Recommendation signals must be bounded and testable.
- Explicit preferences, learned affinities, follows, recency, impact, exploration, and
  diversity should remain independently inspectable.
- Following labels should render from stable entity IDs where possible.
- Any persisted preference, history, or interaction key must be scoped to the signed-in user.

## Testing

- Add deterministic utility tests for ranking, normalization, deduplication, and localization.
- Add service tests with realistic provider-shaped fixtures.
- Run `npm test`, `npm run lint`, and `npm run build` after changes that affect shared feed or
  routing behavior.

