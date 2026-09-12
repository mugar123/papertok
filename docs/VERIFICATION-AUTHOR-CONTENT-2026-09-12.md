# Author content loading and motion verification

The author column stays at full opacity while its data resolves. Its identity,
ORCID badge and career blocks own their individual fades instead of inheriting
another fade on the entire column. The badge resolves in place; biography,
links and education settle 6px over 420ms with a separate 360ms linear fade.
Employment rows have a small stagger capped at 160ms. Their panel fades as one
surface, avoiding a second opacity animation on each row.

Opening and closing professional experience use a 300ms height transition with
the same gentle curve as the chevron. Automatic data arrival still mounts at
full height: the existing hero height-settle hook remains the only owner of
that space. Reduced-motion selectors cover the new badge, header and row rules.

Two loading-state changes address possible flicker:

- An author with a known ORCID reserves the loading slot from its first live
  render and retains it while the entity record refreshes. Completion and
  failure both release the pending state.
- The deferred overlay reset no longer clears ORCID or resets the experience
  disclosure. Only the entity loader owns those states, so a fast response
  cannot be overwritten by a later timer. The timer is also cancelled on cleanup.

Employment and education organisation actions now use native buttons rather
than clickable divs. Their minimum height is 24px; the disclosure target is
at least 32×28px. Existing bilingual names and focus indicators remain.

## Checks

- 76 focused explorer loading, motion, reservation and height-settle tests passed.
- `npm run check` passed: secret scan, lint, 2,740 tests, production/PWA build
  and Worker deployment dry run. Wrangler could not write its optional log
  outside the sandbox, but completed the bundle and dry run with exit code 0.
- `git diff --check` passed.

## Accessibility evidence

Source checks do not constitute a WCAG conformance claim.

| Page or flow | Component | WCAG criterion | Result | Evidence | Defect or limitation | Retest |
|---|---|---|---|---|---|---|
| ORCID and career arrival | EntityExplorer.css | 2.3.3 Animation from Interactions (AAA enhancement; project motion requirement) | Cumple (source) | Tests verify reduced-motion coverage of the new animation selectors | Preference emulation and visual smoothness not tested in a browser | Open an author with reduced motion on and off |
| Employment and education organisations | EntityExplorer.jsx | 2.1.1 Keyboard; 4.1.2 Name, Role, Value | Cumple (source) | Regression test verifies both actions are native buttons without synthetic keyboard handlers | No manual keyboard or screen-reader session | Activate each with Enter and Space |
| Career controls | EntityExplorer.css | 2.5.8 Target Size | Cumple (source) | Organisation buttons have 24px minimum height; disclosure is 32×28px minimum | Rendered geometry not measured | Inspect controls at mobile and desktop widths |
| ORCID loading and experience disclosure | EntityExplorer | 2.4.7 Focus Visible; 2.4.11 Focus Not Obscured; 1.4.10 Reflow | No verificado | Existing focus styles and hero height-settle mechanism retained | Live keyboard, clipping, zoom and layout verification unavailable | Navigate a long career with keyboard, including disclosure opening and closing |

Browser access remains unavailable because automatic approval review rejected
the local browser operation with an internal HTTP 403 model-permission error.
The loading-state regressions are covered by source tests; the reported flicker
has not been reproduced or measured visually in this session.
