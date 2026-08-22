/**
 * On-demand KaTeX. The library is ~80 KB gzip of JS plus a stylesheet and most
 * cards carry no math, so it loads on the first formula that actually renders
 * instead of riding in the feed's critical chunk (measured 2026-08-22: the
 * single 2 MB bundle cost 0.9–1.3 s of parse before any content).
 *
 * The stylesheet loads alongside the module but never gates it: a lost CSS
 * chunk costs styling for a moment, not the formulas themselves. Under node
 * (tests) the CSS import always rejects and that is fine for the same reason.
 */

let katexModule = null;
let katexPromise = null;

/** The loaded module, or null while it is still on its way. */
export function getKatex() {
  return katexModule;
}

export function loadKatex() {
  if (!katexPromise) {
    katexPromise = import('katex')
      .then(module => {
        katexModule = module.default || module;
        return katexModule;
      })
      .catch(() => {
        // A failed chunk load (offline, deploy in flight) may retry on the
        // next math render instead of disabling formulas for the session.
        katexPromise = null;
        return null;
      });
    import('katex/dist/katex.min.css').catch(() => {});
  }
  return katexPromise;
}
