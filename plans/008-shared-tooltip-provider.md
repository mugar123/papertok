# 008 — One tooltip provider for the app, so adjacent tooltips open instantly

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: MEDIUM
- **Category**: 2 (Easing & duration: delay) and 7 (Cohesion)
- **Estimated scope**: 2 source files (`ui/tooltip.jsx`, `App.jsx`), ~8 lines

## Problem

Every `<Tooltip>` wraps **its own** Base UI provider:

```jsx
// src/components/ui/tooltip.jsx:9-15 — current
function Tooltip({ delay = 600, ...props }) {
  return (
    <TooltipPrimitive.Provider delay={delay}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipPrimitive.Provider>
  );
}
```

A provider is what groups tooltips. Base UI's own doc comment
(`node_modules/@base-ui/react/tooltip/provider/TooltipProvider.d.ts:3-5`):
*once a tooltip becomes visible, the adjacent tooltips will be shown instantly*
(within `timeout`, default 400ms). With one provider per tooltip there is no
group, so moving along the citation map's stars, or along the path crumbs,
waits the full 600ms on every single one. The first tooltip should wait; the
next ones should not.

Callers (none pass `delay`):

- `src/components/Public/GuestInterestsPrompt.jsx:49`
- `src/components/Feed/PaperCard.jsx:132`
- `src/components/Feed/RelatedPapersSheet.jsx:96, 509, 870`

The app root is `App()` in `src/App.jsx` (around line 591):

```jsx
// src/App.jsx — current
function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <LanguageProvider>
          <AnalyticsProvider>
            <UserScopedAppContent />
          </AnalyticsProvider>
        </LanguageProvider>
      </AuthProvider>
      ...
```

## Target

- Exactly one `TooltipPrimitive.Provider` in the app, with `delay={600}`,
  wrapping `<UserScopedAppContent />`.
- `Tooltip` renders only `TooltipPrimitive.Root`. Drop the unused `delay` prop
  from its signature rather than forwarding it (no caller uses it; a per-tooltip
  delay is `TooltipTrigger`'s `delay` prop in Base UI 1.8 if ever needed).
- `timeout` stays at Base UI's default (400ms).

## Repo conventions

Export the provider from `src/components/ui/tooltip.jsx` as `TooltipProvider`
(a thin `<TooltipPrimitive.Provider delay={600} {...props} />`), the way the
other `ui/*` wrappers re-export Base UI parts, and import that in `App.jsx`.
Move the "after the pointer has rested on its trigger (600ms)" doc comment
onto the provider.

## Steps

1. In `ui/tooltip.jsx`, add and export `TooltipProvider`. Change `Tooltip` to
   `function Tooltip(props) { return <TooltipPrimitive.Root data-slot="tooltip" {...props} />; }`.
2. In `App.jsx`, wrap `<UserScopedAppContent />` in `<TooltipProvider>`.
3. Grep for any other React root (`createRoot(`) that renders a `Tooltip`
   outside `App`. If one exists, wrap it too; otherwise do nothing.

## Boundaries

- Do not change `TooltipContent`'s styling or its 120ms transition.
- Do not touch the callers' `open` / `onOpenChange` logic (the clipped-only
  tooltips must keep opening only when text is cut).

## Verification

```bash
npm test
npx eslint src/components/ui/tooltip.jsx src/App.jsx
npx vite build
```

Feel check, desktop, a paper with connections open:

1. Rest on one star in the map: the tooltip appears after ~600ms.
2. Slide straight to the next star: its tooltip appears **immediately**.
3. Leave all stars for over half a second, rest on another: the 600ms wait is
   back.
4. Keyboard: Tab to a star. Its tooltip still shows on focus.
5. A crumb that is not cut must still show **no** tooltip.
