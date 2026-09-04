/**
 * On-demand KaTeX. The library is ~80 KB gzip of JS plus a stylesheet and most
 * cards carry no math, so it loads on the first formula that actually renders
 * instead of riding in the feed's critical chunk (measured 2026-08-22: the
 * single 2 MB bundle cost 0.9–1.3 s of parse before any content).
 *
 * The stylesheet is awaited with the module, but a failure to fetch it is not.
 * Waiting matters because KaTeX renders each formula twice — a visual copy and
 * a MathML copy it hides by clipping — and the clip lives in that stylesheet:
 * render before it lands and every formula is printed twice, which in a page of
 * prose is unmissable. Failing on it would be worse than the flash, so a CSS
 * chunk that never arrives costs styling and never the formulas. Under node
 * (tests) that import always rejects, and that is exactly the tolerated case.
 */

let katexModule = null;
let katexPromise = null;

/** The loaded module, or null while it is still on its way. */
export function getKatex() {
  return katexModule;
}

export function loadKatex() {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css').catch(() => null),
    ])
      .then(([module]) => {
        katexModule = module.default || module;
        return katexModule;
      })
      .catch(() => {
        // A failed chunk load (offline, deploy in flight) may retry on the
        // next math render instead of disabling formulas for the session.
        katexPromise = null;
        return null;
      });
  }
  return katexPromise;
}
