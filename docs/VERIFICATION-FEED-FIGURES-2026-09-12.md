# Feed figure entrance verification

The figure entrance now separates opacity from movement. A 480ms linear fade
shares its start and finish with a gentle eased settle from 16px below and
98.5% scale. Figures keep their final tilt throughout, avoiding a simultaneous
rotation as they become visible. A 60ms stagger lets four cached figures finish
within 660ms of the first, instead of 690ms. Individual network loads still
gate each image's appearance.

The science watermark fades on the same clock and linear curve as the first
image. Returning from an entity retains the existing short resume fade.
The reduced-motion rule now also overrides the more specific resumed-figure
selector, which previously let its infinite drift continue.

## Checks

- 23 focused figure, watermark, contrast, arrival and transform tests passed.
- `npm test`: 2,738 passed, no failures or skipped tests.
- `npm run lint`: passed without errors or warnings.
- `npm run build`: passed including PWA generation; Vite retains its large-chunk advisory.
- `git diff --check` passed.

## Accessibility evidence

Source checks below are not a WCAG conformance claim.

| Page or flow | Component | WCAG criterion | Result | Evidence | Defect or limitation | Retest |
|---|---|---|---|---|---|---|
| Feed image arrival and return from an entity | PaperCard.css | 2.3.3 Animation from Interactions (AAA enhancement; project reduced-motion requirement) | Cumple (source) | Figure entrance test verifies movement and resumed drift are disabled under reduced motion | Runtime preference emulation unavailable | Return from an entity with reduced motion enabled; figures must remain still |
| Decorative feed figures | PaperCard.jsx | 1.1.1 Non-text Content | Cumple (source) | Existing figure wrapper remains `aria-hidden="true"`; images retain empty alt text | No screen-reader session performed | Confirm decorative figures are absent from the accessibility tree |
| Figure arrival | PaperCard.css | 1.4.10 Reflow | No verificado | No changes to slot sizes, layout or the existing 1080px visibility breakpoint | Browser review unavailable | Review a desktop card with 1–4 images and a narrow viewport |
| Figure entrance | PaperCard | 2.1.1 Keyboard | No aplicable | Figures are decorative and contain no controls; no interaction or focus behavior changed | Existing feed keyboard navigation was not manually retested | Check feed navigation during visual review |

The user's local Vite server was detected listening on `127.0.0.1:5173`.
Opening it in the browser tool was rejected by automatic approval review with
an internal HTTP 403 model-permission error. Visual timing, cached/cold-image
appearance and assistive-technology checks remain unverified in this session.
