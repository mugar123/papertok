# PaperTok — Design System

The interface language every screen is built in. Read this before adding a
feature; copy these conventions rather than inventing new ones. The language is
already shipping in five reference files — look at them when a rule is unclear:

| File | What it shows |
| --- | --- |
| `src/components/Feed/PaperCard.css` | the card, the field colour, the voices |
| `src/components/Reader/PaperReader.css` | long-form reading, floating controls |
| `src/components/Report/ScientificReport.css` | editorial layout, ruled columns |
| `src/components/Layout/Navbar.css` | flat chrome, the brand thread |
| `src/components/Search/SearchCommand.css` | overlay surfaces |

The Explorer (`src/components/Explorer/EntityExplorer.*`) and the sign-in modal
(`src/components/Public/AuthPrompt.*`) are worked examples of the whole system.

---

## The idea in one line

A white, document-first product that reads like a machine-generated index over
editorial content. Structure comes from **hairline rules**, not shadows;
metadata is set in **mono**; anything you read as prose is set in a **serif**;
and every splash of colour **comes from the data**, never from decoration.

---

## The seven rules

### 1. Three voices, never mixed by accident
- **Inter** (`--font-body` / `--font-heading`) — all UI and controls.
- **Newsreader** (`--font-serif`) — anything read as prose: titles, abstracts,
  article body, entity names.
- **IBM Plex Mono** (`--font-mono`) — every piece of machine data: categories,
  years, counts, IDs, source names, timestamps, section labels.

Any small uppercase label uses the shorthand:

```css
font: var(--mono-label);
letter-spacing: var(--mono-track);
text-transform: uppercase;
```

### 2. Colour comes from the data, not from decoration
A paper carries its research field. Use `var(--area-accent)` for its rule, its
category name and its tinted chips. Derive tints instead of hardcoding a second
value:

```css
background: color-mix(in srgb, var(--area-accent) 8%, var(--bg-card));
```

Set `--area-accent` on a container from the entity's/paper's field with the
`getAreaGradient()` helper pattern (see `EntityExplorer.jsx`), which resolves a
category id to one of the twelve `--gradient-*` field colours.

For controls with a meaning of their own (not tied to a field), use the action
accents — each has a matching `-soft` and `-line`:
`--accent-violet` / `--accent-teal` / `--accent-rose` / `--accent-sky`
(+ `--accent-success`).

### 3. The yellow is a thread, not a highlight reel
`--brand-yellow` marks only: the **active nav/tab item**, the **AI reading
action**, **user highlights**, and — as `--brand-orange` — the **focus ring**.
Nothing else.

### 4. Corners are near-square, borders are visible
Always use the radius tokens — never a pixel radius:
`--radius-sm 2px` · `--radius-md 3px` · `--radius-lg 4px` · `--radius-xl 6px` ·
`--radius-2xl 8px`. Only avatars and meters use `--radius-full`.
Borders come from `--border-subtle` / `--border-default` / `--border-strong` /
`--border-ink`. Structure is hairline rules, not shadows.

### 5. Buttons come from the component, not from CSS
```jsx
import { Button } from '../ui/button.jsx';
```
Variants: `default` (ink), `outline`, `ghost`, `brand` (yellow), `violet`,
`teal`, `rose`, `sky`, `success`, `field` (adopts `--accent` of its element),
`destructive`. Sizes: `default`, `sm`, `lg`, `icon`, `icon-sm`. Full width with
the `w-full` utility. Delete any bespoke `.foo-btn` rules you replace.
Dialogs, palettes, toggles and tooltips already exist in `src/components/ui/`.

### 6. Group actions by intent
Primary actions cluster left. Utility icons cluster right behind a `1px` rule.
Push the gap from the primary group with `margin-right: auto` so the layout
holds whether or not the middle group renders.

### 7. Sizes bend to the viewport
Any clamp on content height uses viewport units, never a fixed `em`, or content
gets cut while the screen sits empty. See the abstract's
`max-height: min(30em, 46vh)`.

---

## Tokens

All tokens live in `src/styles/variables.css`. **Do not introduce new colour
values** — add a token there if one is genuinely missing, then reference it.
`grep` before assuming a token is already in use.

**Ground & ink** — `--bg-primary #fff`, `--bg-secondary`, `--bg-card`,
`--bg-sunken`, `--bg-glass` / `--bg-glass-hover` (ink washes); `--text-primary`,
`--text-secondary`, `--text-tertiary`, `--text-inverse`.
There is **no `--text-muted`** — use `--text-tertiary`.

**Rules** — `--border-subtle` · `--border-default` · `--border-strong` ·
`--border-ink`.

**Field colours (12)** — `--gradient-{physics,cs,math,stat,econ,qfin,eess,mech,
civil,chemeng,med,bio}`, flat print inks. `--gradient-brand` is ink, the
fallback when no field applies.

**Status tints** — `--tint-{blue,green,amber,red,violet,neutral}-{bg,fg,line}`
for badges and inline messages.

**Type scale** — `--fs-xs … --fs-5xl`; weights `--fw-regular…bold`; line heights
`--lh-tight/normal/relaxed`. Spacing `--space-1 … --space-24`. Shadows
`--shadow-sm…xl` (barely-there; elevation is a border + short drop).
Transitions `--transition-fast/base/slow/spring`.

---

## Shared components (`src/components/ui/`)

- **`button.jsx`** (+ `button-variants.js`) — the only button. See rule 5.
- **`dialog.jsx`** — Radix dialog (overlay + content + close). Use for modals
  instead of hand-rolling a backdrop.
- **`command.jsx`** — cmdk command palette (see `SearchCommand`).
- **`toggle-group.jsx`** (+ `toggle-group-context.js`) — segmented choices; the
  selected item is a raised white chip on a sunken track.
- **`tooltip.jsx`** — Radix tooltip.
- **`../../lib/utils.js`** — `cn()` merges class names (clsx + tailwind-merge),
  letting a caller's utility win over a component default.

Tailwind v4 is wired via `@tailwindcss/vite`; utility classes (`w-full`,
`flex`, …) work in JSX. Element resets live in `@layer base` in
`src/styles/global.css` — see the traps below.

---

## Recurring patterns

- **Mono kicker / section label** — `font: var(--mono-label)` + track, uppercase,
  `--text-tertiary` (or `--area-accent` when it names a field).
- **Field rule** — a `34px × 3px` bar of `var(--area-accent)` above a headline
  (`.pc-body::before`, `.ehc-info::before`).
- **Ruled rows** — a list is hairline-separated rows on `--bg-card`, each with a
  short `3px` field rule down the inner edge, a mono meta line, a serif title.
  No cards, no shadows (see Explorer's `.explorer-grid`, Report's `.sr-bento`).
- **Editorial layout** — serif nameplate over a `3px double` rule, a lead story,
  the rest in ruled columns (`ScientificReport.css`).
- **Overlay surfaces** — ink scrim `rgba(17,19,24,0.4)` + `blur`, a white sheet
  with `--border-default` and `--shadow-xl`, near-square top corners. Framer
  Motion for enter/exit; respect `prefers-reduced-motion`.
- **Chips / tags** — `1px` border, `--radius-sm`, mono or small Inter, tinted
  from the field or a status tint.
- **Stat block** — mono tabular-nums value over a mono uppercase label, in a
  ruled grid (`.ehc-stats-grid`, `.sr-stat`).

---

## Auth pattern — two doors, and they are not interchangeable

Sign-in has two entry points. Which one you reach for is decided by a single
question: **did the user already get taken somewhere else?**

**The modal — `src/components/Public/AuthPrompt.jsx`.** The in-context door,
opened by calling `requestAuthentication` (passed to screens as
`onAuthRequired`). It does Google + GitHub sign-in on the spot and closes itself
once a session exists, leaving the user exactly where they were. That is the
whole point: someone who tapped "save" on a paper should still be looking at
that paper afterwards. It deliberately offers **no** way out to `/login` — there
is nothing to return to.

**The page — `/login`, `src/components/Auth/LoginPage.jsx`.** The destination for
the trips that already moved the user: a direct link, a shared URL, or
`ProtectedRoute` intercepting a gated route. Those are the only journeys that
have somewhere to go back to, so they are the only ones that carry a `returnTo`.
`ProtectedRoute` redirects with `state={{ returnTo: pathname + search }}`; the
page reads it back from `location.state` (or a `?returnTo=` query, for links
built outside the app), validates it, and lands the user there once the session
exists — or passes it through `/onboarding` first, so it survives that too. The
route is `lazy`, because a session that already exists never renders it.

**Adding an auth entry point:** wire `onAuthRequired` and use the modal. Reach
for `/login` only when the user has already been navigated away from what they
wanted, and then always carry the `returnTo` — a redirect that drops it is the
bug this pattern exists to prevent.

> Earlier drafts of this file said "never reintroduce a `/login` page". That rule
> was reversed on 2026-08-24: it optimised for the in-context case and silently
> broke the other one, leaving a guest who opened a shared link to a gated route
> stranded on the feed with no memory of where they were going.

---

## Traps (each one cost real time)

- **Unlayered CSS beats every cascade layer.** An unlayered
  `button { background: none }` in `global.css` silently defeated every Tailwind
  background utility on shadcn buttons. Element resets live in `@layer base` —
  do not move them out, and do not add element-level rules outside a layer.
- **Animations don't run under `content-visibility`.** Inside the feed's
  `content-visibility: auto` subtree the browser skips animations, and
  `animation: … both` then pins the element at its `from` state (usually
  `opacity: 0`, so it never appears). Set the final value statically. The same
  subtree also stops `loading="lazy"` images from ever loading.
- **Tokens don't reach hardcoded values.** Changing a token fixes nothing while
  a hardcoded hex/rgba/pixel-radius bypasses it. `grep` for literals in any file
  you touch and fold them back onto tokens.
- **A utility from a plugin you didn't install generates nothing, silently.**
  Copied shadcn source fades its dialog overlay with `animate-in` / `animate-out`,
  which belong to `tailwindcss-animate`, not to Tailwind. Without that dependency
  the classes produce no rule at all — no warning, no missing-class error, just an
  overlay that appears and vanishes in one frame and reads as "the animation is
  too fast". When you paste a component from upstream, check every utility it uses
  actually exists here. The overlay now fades with the `fadeIn` / `fadeOut`
  keyframes `variables.css` already defines. It must be an `animation`, not a
  `transition`: `@radix-ui/react-presence` only defers unmount while
  `getComputedStyle(node).animationName` is not `none`, so a transitioned exit is
  cut off by the unmount.
- **Don't cache a failure.** Cache successes long, unknowns briefly, failures
  never — and share in-flight promises so a double mount cannot race itself.
- **`createContext` must not share a module with a component.** A module that
  defines a component is a Fast Refresh boundary; re-evaluating it mints a new
  context that mounted consumers aren't holding. Put `createContext` in its own
  component-free module (see `toggle-group-context.js`,
  `button-variants.js`). Enforced by `src/context/contextIdentity.test.js`.

---

## Deliberately unfinished

- Figure clippings only appear above `1080px`; below that the text column can't
  spare the margin.
- Short abstracts leave a gap at the top of a card (a product call: centre, or
  promote a figure into the empty band).
- The `/ai/explain` endpoint has no caller since the Reader replaced the
  explainer — decide whether it becomes the abstract-only fallback or is deleted.
- Figures are not licence-checked; arXiv licences vary.

---

## Adding a feature — checklist

1. Read the nearest reference file; reuse its classes and structure.
2. Voices: serif for prose, mono for machine data, Inter for controls.
3. Colour: `--area-accent` for field, action accents for meaning, tints via
   `color-mix`. No new hex.
4. Radii and borders from tokens only. Structure from rules, not shadows.
5. Buttons and overlays from `src/components/ui/`. No bespoke `.foo-btn`.
6. Group actions by intent; utility icons behind a `1px` rule.
7. Respect `prefers-reduced-motion`; keep hover effects behind
   `@media (hover: hover) and (pointer: fine)`.

**Done means:** `npm run lint && npm test && npm run build` all pass; no
hardcoded hex or pixel radius remains in the files you touched; and the screen
has been looked at in a browser at `1280px` and at `375px`.
