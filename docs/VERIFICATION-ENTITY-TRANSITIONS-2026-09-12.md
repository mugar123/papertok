# Entity navigation motion verification

Opening a project, institution or author now uses a horizontal detail push.
The detail travels 56px from the right over 280ms; Back retraces that path
over 240ms. The feed underneath yields 18px to the left and returns without
scaling its text or figures. Linear opacity transitions finish in approximately
100ms while the travel continues. Navbar tab transitions keep their existing
direction, travel and timing.

The shared `PageTransition` component also hides an outgoing page when its
own animations finish, before notifying `AnimatePresence`. Nested exits can
therefore delay unmounting without leaving a held page painted above the newly
settled page. Re-entering a page restores its visibility. Other routes using
the same hierarchical transition inherit this motion.

## Automated checks

- 68 focused navigation, feed restoration, figure and explorer tests passed.
- `npm run build` passed, including PWA generation; Vite reported its
  advisory about large chunks.
- `npm test` passed: 2,738 tests, no failures or skipped tests.
- `npm run lint` passed without errors or warnings.
- `git diff --check` passed.

## Accessibility evidence

The results below distinguish source-level guarantees from browser testing;
they do not constitute a WCAG conformance claim.

| Page or flow | Component | WCAG criterion | Result | Evidence | Defect or limitation | Retest |
|---|---|---|---|---|---|---|
| Open entity / Back to feed | PageTransition.css | 2.3.3 Animation from Interactions (AAA enhancement; project reduced-motion requirement) | Cumple (source) | Existing motion tests verify every animated state switches to a short opacity-only transition under `prefers-reduced-motion: reduce` | Browser preference emulation not run | Check all three entity types with reduced motion enabled |
| Overlapping routes | PageTransition.jsx | 2.4.3 Focus Order; 4.1.2 Name, Role, Value | Cumple (source) | Outgoing page remains `inert`; regression assertion verifies visibility is removed after its own animations finish even if nested exits remain | Real assistive-technology behavior not verified | Open and close an entity with keyboard and a screen reader |
| Back in loading, error and resolved views | EntityExplorer.jsx | 4.1.2 Name, Role, Value | Cumple (source) | Existing button carries bilingual `Back` / `Volver` accessible name and invokes the shared history handler in each state | No control semantics changed; runtime keyboard activation not verified | Activate Back using Enter and Space |
| Entity navigation / returning to the feed | Shared route wrapper | 2.1.1 Keyboard; 2.4.7 Focus Visible; 2.4.11 Focus Not Obscured | No verificado | Source retains existing native controls and focus handling | Local browser verification unavailable | Tab through entry links, return with Back, inspect visible focus |
| Mobile and desktop navigation | Shared route wrapper | 1.4.10 Reflow | No verificado | Layout dimensions unchanged; motion uses only transform and opacity | Visual review, mobile sizing, rapid Back/Forward and scrolled-page checks not run | Review at 320px and desktop widths, including long entity pages |

The sandbox denied binding the local Vite server to `127.0.0.1:5173`.
The requested escalation was then rejected because the automatic approval
service returned HTTP 403 for an unavailable model alias. No alternative server
was started. Live visual, keyboard and screen-reader verification remain
pending until local preview is available.
