---
name: PaperTok
description: Scientific papers in one feed, printed like an index over editorial content.
colors:
  navy-ink: "#1d2b53"
  ink-hover: "#3e4a6b"
  spot-yellow: "#ffd21e"
  spot-yellow-soft: "#fff4c9"
  link-blue: "#1a5fd0"
  warm-proof-paper: "#fbf8f0"
  ink-wash: "#ebeae5"
  sunken-paper: "#f3f1eb"
  ink-secondary: "#46527a"
  ink-tertiary: "#5a6488"
  rule-subtle: "#e4dccb"
  rule-default: "#d6ccb6"
  rule-strong: "#a59c88"
  accent-violet: "#6d28d9"
  accent-teal: "#0f766e"
  accent-rose: "#be123c"
  accent-sky: "#0369a1"
  accent-like: "#d92d20"
  accent-save: "#b45309"
  accent-success: "#067647"
  field-physics: "#4f46e5"
  field-cs: "#c2410c"
  field-math: "#7e22ce"
  field-stat: "#1d4ed8"
  field-econ: "#0f766e"
  field-qfin: "#0e7490"
  field-eess: "#a16207"
  field-mech: "#475569"
  field-civil: "#92400e"
  field-chemeng: "#4d7c0f"
  field-med: "#be123c"
  field-bio: "#15803d"
  night-paper: "#14161d"
  night-card: "#1b1c23"
  night-ink: "#f4ecd8"
typography:
  display:
    fontFamily: "Newsreader Variable, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(2.5rem, 7vw, 4.75rem)"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Newsreader Variable, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(1.9rem, 4.2vw, 2.6rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Newsreader Variable, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(1.45rem, 2.5vw, 2.1rem)"
    fontWeight: 600
    lineHeight: 1.16
    letterSpacing: "-0.015em"
  body-prose:
    fontFamily: "Newsreader Variable, Iowan Old Style, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  body-ui:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.06em"
rounded:
  sm: "2px"
  md: "3px"
  lg: "4px"
  xl: "6px"
  2xl: "8px"
  full: "9999px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
  "10": "2.5rem"
  "12": "3rem"
  "16": "4rem"
components:
  button-primary:
    backgroundColor: "{colors.navy-ink}"
    textColor: "{colors.warm-proof-paper}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-outline:
    backgroundColor: "{colors.warm-proof-paper}"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  button-outline-hover:
    backgroundColor: "{colors.ink-wash}"
  button-ghost:
    textColor: "{colors.ink-tertiary}"
    rounded: "{rounded.md}"
  button-brand:
    backgroundColor: "{colors.spot-yellow-soft}"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.md}"
  button-brand-hover:
    backgroundColor: "{colors.spot-yellow}"
  chip-field:
    textColor: "{colors.field-physics}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  rail-tile:
    rounded: "{rounded.md}"
    size: "48px"
  menu:
    backgroundColor: "{colors.warm-proof-paper}"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.lg}"
    padding: "6px"
  menu-item-highlighted:
    backgroundColor: "{colors.sunken-paper}"
    rounded: "{rounded.md}"
    height: "34px"
  navbar:
    backgroundColor: "{colors.warm-proof-paper}"
    height: "64px"
---

# Design System: PaperTok

The interface language every screen is built in. Read this before adding a
feature; copy these conventions rather than inventing new ones. The tokens in
the frontmatter above are normative and mirror `src/styles/variables.css`; the
prose says where and why to use them. The language already ships in four
reference files — look at them when a rule is unclear:

| File | What it shows |
| --- | --- |
| `src/components/Feed/PaperCard.css` | the card, the field colour, the voices |
| `src/components/Reader/PaperReader.css` | long-form reading, floating controls |
| `src/components/Layout/Navbar.css` | flat chrome, the brand thread |
| `src/components/Search/SearchCommand.css` | overlay surfaces |

The Explorer (`src/components/Explorer/EntityExplorer.*`) and the sign-in modal
(`src/components/Public/AuthPrompt.*`) are worked examples of the whole system.

The seven numbered rules below are cited from code comments as
"design.md, rule N"; they keep their numbers wherever they sit.

## Overview

**Creative North Star: "The PaperTok Index"**

A document-first product printed like a single-ink page — one navy ink on warm paper,
a spot yellow and, on the welcome page, a faint paper grain — that reads like a machine-generated
index over editorial content. The tone is sober, editorial and curious: serious
with the science, with a spark of play (Petri the mascot, the engravings, the
twinkling stars) kept for first-run moments only.

Structure comes from **hairline rules**, not shadows; metadata is set in
**mono**; anything you read as prose is set in a **serif**; and every splash of
colour **comes from the data**, never from decoration. Components feel printed
and quiet: flat, made of ink and rule, with pattern rationed to the few places
that earn it.

There are two themes, and the dark one is the same print at night: the paper
turns to ink (`night-paper`), the ink to paper (`night-ink`), and the spot
yellow does not flip — a mark that changes value stops being a mark.

**Key Characteristics:**
- One ink (Navy) on Warm Proof Paper; the welcome page adds a paper grain.
- Three voices: serif prose, mono machine data, Inter controls.
- Colour only from the data (the twelve field inks) or from an action's meaning.
- Spot Yellow as a thread, never a highlight reel.
- Near-square corners, visible hairlines, no shadows anywhere.
- Patterned buttons (engraved, halftone) only on the landing and onboarding.

## Colors

One ink on warm paper, a single spot colour, and a register of flat print inks
that only the data is allowed to pick.

### Primary
- **Navy Ink** (`navy-ink`): text, solid primary buttons, the active
  state, the focus ring (`--focus-ring`) and the ink frame of an outline
  button. Holds ~17:1 on paper. **Ink Hover** (`ink-hover`) is its pressed and
  hovered step.
- **Spot Yellow** (`spot-yellow`): the brand mark. See rule 3 for the only
  places it may appear. **Spot Yellow Soft** (`spot-yellow-soft`) is its wash,
  behind the AI reading action. Anything on the yellow takes `--text-on-brand`
  (always ink), because the yellow does not flip with the theme.

### Secondary
- **Action accents** (`accent-violet`, `accent-teal`, `accent-rose`,
  `accent-sky`, `accent-success`): controls with a meaning of their own, not
  tied to a field. Each has a `-soft` surface and a `-line` border in
  `variables.css`. **Like** (`accent-like`) and **Save** (`accent-save`) colour
  the rail's own states.
- **Link Blue** (`link-blue`): the secondary accent, for links in running text.

### Tertiary
- **The twelve field inks** (`field-physics` … `field-bio`, the
  `--gradient-*` variables): flat print inks, one per research field, each
  legible as text on paper. A paper or entity carries its field as
  `--area-accent`. `--gradient-brand` is ink, the fallback when no field
  applies. Lists have their own eight-colour palette (`--list-*`), deliberately
  not the field inks: a field colour claims a subject, a list colour claims
  nothing.

### Neutral
- **Warm Proof Paper** (`warm-proof-paper`): the page, cards and every overlay
  sheet.
- **Ink Wash** (`ink-wash`): ink at 7% on paper. The feed's ground and the
  hover fill of an outline control.
- **Sunken Paper** (`sunken-paper`): tracks, wells and a highlighted menu row.
- **Ink Secondary / Ink Tertiary** (`ink-secondary`, `ink-tertiary`):
  supporting text and mono labels. There is **no `--text-muted`**; use
  `--text-tertiary` (5.48:1 on paper).
- **Rules** (`rule-subtle`, `rule-default`, `rule-strong`, plus
  `--border-ink`): hairlines from faint to ink. `rule-subtle` is the hairline rule
  between rows.
- **Status tints** (`--tint-{blue,green,amber,red,violet,neutral}-{bg,fg,line}`):
  badges and inline messages only.

### Named Rules

**Rule 2 — The Data Colour Rule.** Colour comes from the data, not from
decoration. A paper carries its research field: use `var(--area-accent)` for
its rule, its category name and its tinted chips, and derive tints instead of
hardcoding a second value —
`background: color-mix(in srgb, var(--area-accent) 8%, var(--bg-card));`.
Set `--area-accent` from the field with the `getAreaGradient()` helper pattern
(see `EntityExplorer.jsx`).

**Rule 3 — The Yellow Thread Rule.** `--brand-yellow` marks only: the
**engraved button's plate** (landing and onboarding only), the **active nav or
tab item**, the **AI reading action** and **user highlights**. Nothing else. The
focus ring is the ink.

**The No New Hex Rule.** All tokens live in `src/styles/variables.css`. Do not
introduce a colour value at a call site; add a token there if one is genuinely
missing, then reference it. `grep` before assuming a token is already in use.

## Typography

**Prose Font:** Newsreader (`--font-serif`, with Iowan Old Style, Georgia)
**UI Font:** Inter (`--font-body` / `--font-heading`, with the system sans)
**Label/Mono Font:** IBM Plex Mono (`--font-mono`, with SFMono, Menlo)

**Character:** a scholarly serif for everything you read, a neutral grotesk for
everything you press, and a typewriter mono for everything a machine produced —
the voice of an index set by hand.

### Hierarchy
- **Display** (400, `clamp(2.5rem, 7vw, 4.75rem)`, 1.02): the landing's one
  headline, with its second line in italic.
- **Headline** (600, `clamp(1.9rem, 4.2vw, 2.6rem)`, 1.08): onboarding and page
  titles, set balanced.
- **Title** (600, `clamp(1.45rem, 2.5vw, 2.1rem)`, 1.16): a paper's title on
  its card; 1.3rem and four lines at most on a phone.
- **Body prose** (400, 1rem, 1.6): abstracts and article text, with a field-ink
  drop capital opening an abstract. Keep a reading measure (about 40rem, ~70
  characters).
- **Body UI** (400, 0.875rem, 1.5): controls, menus, form text.
- **Label** (600, 0.6875rem, tracking 0.06em, uppercase): every small mono
  label — `font: var(--mono-label); letter-spacing: var(--mono-track);`.

The scale tokens are `--fs-xs … --fs-5xl`, weights `--fw-regular … bold`, line
heights `--lh-tight / normal / relaxed`.

### Named Rules

**Rule 1 — The Three Voices Rule.** Never mixed by accident. Inter for all UI
and controls; Newsreader for anything read as prose (titles, abstracts, article
body, entity names); IBM Plex Mono for every piece of machine data (categories,
years, counts, IDs, source names, timestamps, section labels).

**The Sixteen On A Phone Rule.** Prose on a phone is set at 16px (1rem). The
abstract went from 14px to 16px when its card started giving it the room.

## Layout

The page is one column of document. The feed is a vertical snap scroller of
full-height cards; each card is a sheet of type with an action rail beside it.

- **Breakpoints in use:** 1080px (figure clippings appear above it), 900px
  (the card becomes the whole screen and the rail overlays its right edge),
  768px (navbar height steps down), 640px (phone type and sheet sizes), 600px
  (`useIsPhone`: menus and popovers become bottom drawers).
- **The navbar** is 64px on desktop and 52px on a phone (`--nav-height`,
  `--nav-height-mobile`); `--nav-total` adds the top safe-area inset in one
  place, and everything that offsets from the bar reads it.
- **The card on a phone** is top-anchored: kicker, chips, title and authors
  under the bar, the abstract filling the middle, the actions at the foot where
  the thumb is. Only the abstract yields height; on a tablet the column stops at
  a 40rem reading measure.
- **Spacing** runs on `--space-1 … --space-24` (4px steps up to 2rem, then
  wider). Tight inside a group, generous between groups.

### Named Rules

**Rule 6 — The Intent Grouping Rule.** Primary actions cluster left. Utility
icons cluster right behind a `1px` rule. Push the gap from the primary group
with `margin-right: auto` so the layout holds whether or not the middle group
renders. Nothing that is not an action belongs on that row — metadata rides in
the metadata band. Let a group of actions wrap (`flex-wrap`): labels are
`whitespace-nowrap`, so a row that cannot wrap clips its last action.

**Rule 7 — The Bending Sizes Rule.** Any clamp on content height uses viewport
units, never a fixed `em`, or content gets cut while the screen sits empty
(the desktop abstract: `max-height: min(30em, 46dvh)`).

**The One Scrolling Line Rule.** A strip of chips whose length comes from the
data gets one fixed row rather than a wrap: `overflow-x: auto`, no scrollbar,
`overscroll-behavior-inline: contain`, and a `mask-image` fading the right edge.
Nothing leaves the DOM; keyboard focus scrolls a chip into view (`.pc-topics`,
`.pc-linked-resources-list`).

## Elevation & Depth

Nothing floats. The system is flat: every elevation `--shadow-*` token
(`sm` to `xl`) resolves to `none`; the two `--shadow-glow-*` tokens are the
3px focus ring on fields, not elevation, and stay. Depth is conveyed by
hairline rules and by the step between paper and Ink Wash. The welcome page alone
prints a faint paper grain (`--grain`, two offset blue-noise tiles in the ink,
0.22 light / 0.18 dark); the app's pages are plain paper. An overlay is set
apart by its `rule-default` hairline over a flat scrim (`--scrim`, no blur): the ink
at 30% on light paper, black at 50% in dark, where the cream ink would lift the
page instead of dimming it.

### Named Rules

**The Print Does Not Float Rule.** No `box-shadow` for elevation, no
backdrop blur, no glass. If something needs to sit above the page, it gets a
hairline and, for a modal, the flat scrim.

**The Quiet Frame Rule.** Overlays — dialogs, menus, popovers, the command
palette, sheets — are framed in `--border-default`, the same as the account
menu. The ink frame (`--border-ink`) is for focus, active and pressed states,
not for a surface at rest.

## Shapes

Print has corners. Radii are near-square and always come from tokens: `sm` 2px,
`md` 3px, `lg` 4px, `xl` 6px, `2xl` 8px; only avatars and meters use `full`.
Borders are visible and come from the rule tokens.

### Named Rules

**Rule 4 — The Near-Square Rule.** Always use the radius tokens — never a
pixel radius. Structure is hairline rules, not shadows.

## Components

Printed and quiet: flat ink and rule, with pattern kept for first-run moments.
Everything below lives in `src/components/ui/` — shadcn/ui on **Base UI**
(`@base-ui/react`), each part redrawn with these tokens (near-square radii,
hairlines, mono labels, serif prose, no `dark:` — the theme is the token
re-binding on `data-theme`). Reach for these before a `div` with a click
handler or a hand-rolled overlay.

### Buttons
- **Shape:** near-square (`md`, 3px).
- **Primary (`default`):** solid ink with paper text. **`outline`:** paper in
  an ink frame, filling with Ink Wash on hover. **`ghost`:** tertiary ink,
  wash on hover. **`brand`:** the soft yellow, the AI reading action only.
  **`violet` / `teal` / `rose` / `sky` / `success`:** a tinted surface for an
  action with a meaning of its own. **`field`:** adopts the `--accent` of its
  element. **`destructive`:** solid danger.
- **Sizes:** `default` 40px, `sm` 32px, `lg` 44px (40px on a phone in the
  welcome flow), `icon`, `icon-sm`. Full width with `w-full`.
- **Press:** a 0.97 squeeze on the native `scale` property, 150ms ease-out;
  reduced motion keeps the colour change and drops the squeeze.

**Rule 5 — The Rationed Pattern Rule.** Buttons come from the component
(`import { Button } from '../ui/button.jsx'`), not from CSS; delete any bespoke
`.foo-btn` you replace. The patterned pair is rationed: `engraved` (a hatched
ink frame around a yellow plate) and `halftone` (a paper plate over a 1-bit
checker shadow) draw the eye, and a pattern on every screen stops being one.
`engraved` is the one primary action of the landing (Get started) and of the
welcome/onboarding foot; `halftone` is the landing's account button, its
theme switch and the Privacy button beside it. Never more than one engraved
button on a screen, never on icon buttons inside the app, never in dense
screens (feed, reader, explorer, settings, dialogs). `buttonPatterns.test.js` holds the list; a new place is a
design decision, made here and there together. The label always sits on a
solid plate, never on the pattern (`.btn-engraved` / `.btn-halftone` in
`src/components/ui/button.css`).

### Chips
- **Style:** `1px` border, `sm` radius, mono or small Inter, tinted from the
  field (`color-mix` of `--area-accent`) or from a status tint.
- **State:** toggles are `aria-pressed` chips (`toggle.jsx`); a toggle group's
  `value` is always an array.

### Cards / Containers
- **No card chrome on the feed:** the paper is set directly on the ground and
  the type does the work a container used to do.
- **Ruled rows:** a list is hairline-separated rows on paper, each with a short
  `3px` field rule down the inner edge, a mono meta line and a serif title
  (Explorer's `.explorer-grid`).
- **Field rule:** a `34px × 3px` bar of `var(--area-accent)` above a headline
  (`.pc-body::before`, `.ehc-info::before`).
- **Stat block:** mono tabular-nums value over a mono uppercase label, in a
  ruled grid (`.ehc-stats-grid`).

### Inputs / Fields
- **Style:** a hairline frame on paper, near-square.
- **Focus:** the border turns to ink, doubled by an inset ink hairline — the
  same indicator for keyboard and mouse (WCAG 2.4.7). The command palette's
  field is the one exception: it opens focused inside a framed sheet, so it
  draws no frame of its own.

### Navigation
- **Navbar:** flat paper bar, 64px, a hairline under it. Tabs are Inter with the
  active one marked by a sliding yellow rule (the brand thread). The search bar
  sits on paper and takes Ink Wash on hover; ⌘K / Ctrl+K or `/` opens the
  command palette, which grows from its own centre. On `/search` the bar holds
  the search page's own field and scope instead, and the shortcut focuses it;
  on a phone that field takes the tabs' place.
- **Account menu:** a Base UI menu framed in `rule-default`, rows that take
  Sunken Paper when highlighted.

### Overlays
- **`dialog.jsx`:** the centred modal over the flat scrim; Base UI owns focus,
  Escape, outside press and restore. `alert-dialog.jsx` for confirmations.
- **`dropdown-menu.jsx` / Base UI Menu:** a `role="menu"` of commands, opening
  from its trigger. The share menu is the model: the link first, then each
  destination by name.
- **`drawer.jsx`:** the bottom sheet a thumb dismisses (swipe, snap points). On
  a phone a menu becomes a drawer of 52px rows.
- **`popover.jsx`**, **`sheet.jsx`**, **`tooltip.jsx`**, **`tabs.jsx`**
  (`line` with the yellow underline, `pill` on a sunken track), and the form
  controls (`switch`, `checkbox`, `radio-group`, `select`, `input`,
  `textarea`).
- **Toasts:** Sonner (`ui/sonner.jsx`) on paper with a hairline; a success
  carries the check icon. On a phone, a toast confirming a sheet's action comes
  in at the top, clear of the thumb.

### The Action Rail (signature)
The card's right-hand column: Like, Save, Connections, Similar papers and More
(⋯). Each is an icon-only ghost button, a 28px glyph in its own colour (`--rail`)
on a 52px tap area, with no tile behind it at rest; a fine pointer's hover fills
that area with its colour at 10%, and the active state is the filled glyph. Like and
Save pulse when turned on and press in when turned off, and stay still under
reduced motion. No counts until per-paper totals exist; the names stay in the
DOM for assistive tech and in a native `title`. Save puts the paper in Read
later at once, with an "Add to list" toast; a second press takes it out of
Read later and every list, with Undo. On a touch screen, holding Save for half
a second opens the list picker instead, saved or not. Connections is a toggle:
wider than a phone it swaps the abstract for the citation map until it is pressed again; on
a phone it opens the map as a sheet. Similar papers opens a feed of
recommended papers in a full-screen layer that grows out of the button and
folds back into it (`Feed/SimilarFeedLayer.tsx`). More opens the paper's options
(`Feed/PaperMenu.tsx`), a dialog on desktop and a drawer on a phone: the
actions with a one-line hint each and their glyph on a tint of the action's own
accent (About this paper, Mark as read, Not
interested, the BibTeX/RIS exports), then the share destinations. About this
paper replaces the actions in the same surface, with a back arrow, and holds
the status chips, topics, funding and links that are not on the card face;
topics and funding are ruled rows, the field's rule in its ink and its topics'
in a lighter one. Its heading and sections come in from the right one after
another, and the back arrow brings the actions in from the left; opening the
menu moves nothing inside it.

### Status Screens (signature)
An error, a not-found or an empty result is a glyph on a `56px` tinted square
(`--tint-red-*` when a request failed, `--tint-neutral-*` when nothing did), a
serif heading, one sentence saying what to do, and the way out as labelled
`Button`s. Never an emoji, never a bare icon button as the only exit.

## Do's and Don'ts

### Do:
- **Do** read the nearest reference file and reuse its classes and structure.
- **Do** set prose in the serif, machine data in mono and controls in Inter
  (rule 1).
- **Do** take colour from `--area-accent` for a field and from the action
  accents for meaning, deriving tints with `color-mix` (rule 2).
- **Do** use the radius and border tokens only, and build structure from rules
  (rule 4).
- **Do** take buttons and overlays from `src/components/ui/` (rule 5).
- **Do** group actions by intent, utility icons behind a `1px` rule (rule 6).
- **Do** respect `prefers-reduced-motion`, and keep hover effects behind
  `@media (hover: hover) and (pointer: fine)`.
- **Do** look at the screen in a browser at `1280px` and at `375px` before
  calling it done.

### Don't:
- **Don't** introduce a hex, rgba or pixel radius at a call site.
- **Don't** use a shadow, a blur or glass for elevation.
- **Don't** put the yellow anywhere rule 3 does not list.
- **Don't** put an engraved or halftone button inside the app's dense screens,
  or more than one engraved button on any screen.
- **Don't** frame an overlay at rest in ink; ink is for focus and state.
- **Don't** use an emoji or a Unicode glyph as an icon; icons are Phosphor.

---

## Shared components — wiring notes

- **`button.jsx`** (+ `button-variants.js`) — the only button. Compose with a
  non-button through `render={<a href … />}` (Base UI's render prop; there is
  no `asChild`).
- **`command.jsx`** — cmdk command palette on the Dialog (see `SearchCommand`).
- **`../../lib/utils.js`** — `cn()` merges class names (clsx + tailwind-merge),
  letting a caller's utility win over a component default.
- Add a new primitive with `npx shadcn add <name>` (`components.json` style
  `base-nova`), then redraw it in this vocabulary before it ships.

Base UI's docs travel with the package:
`node_modules/@base-ui/react/docs/react/components/<name>.md`. Its state
attributes are what component CSS styles: `[data-open]` / `[data-closed]` for
an animation, `[data-starting-style]` / `[data-ending-style]` for a
transition, `[data-pressed]`, `[data-checked]`, `[data-active]`,
`[data-highlighted]`, `[data-popup-open]`. A popup is portaled to `<body>`, so
a selector rooted in a page container does not reach it.

Tailwind v4 is wired via `@tailwindcss/vite`; utility classes (`w-full`,
`flex`, …) work in JSX. Element resets live in `@layer base` in
`src/styles/global.css` — see the traps below.

---

## Auth pattern — two doors, and they are not interchangeable

Sign-in has two entry points. Which one you reach for is decided by a single
question: **did the user already get taken somewhere else?**

**The modal — `src/components/Public/AuthPrompt.tsx`.** The in-context door,
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
  actually exists here. The overlay fades with the `fadeIn` / `fadeOut`
  keyframes `variables.css` already defines.
- **An exit that nothing is running is no exit.** Base UI keeps a closing popup
  mounted only while `element.getAnimations()` reports something on it — a CSS
  `animation` on `[data-closed]` or a `transition` on `[data-ending-style]`.
  A closed state styled with neither is unmounted on the spot, and the leave is
  cut off at its first frame, which reads as "too fast" rather than as a bug.
  Animations take `both` so the last frame holds. And a component whose parent
  unmounts it on close (`{open && <X/>}`) must flip its own `open` first and
  call the parent from `onOpenChangeComplete(false)`, or the parent wins.
- **A scale entrance moves small glyphs.** A popup growing from 97% carries
  its icons a pixel and re-rasterises them as the scale lets go; a row of small
  icons reads as settling into place. Where that shows (the share surfaces),
  arrive on opacity alone.
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
- On a tablet, a short abstract leaves room between its last line and the
  actions at the foot (the price of keeping the actions where the thumb is; on
  a desktop the sheet centres instead).
- Figures are not licence-checked; arXiv licences vary.
- The rail shows no like or save counts: likes and saves are stored per user,
  and no per-paper totals exist yet.

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
