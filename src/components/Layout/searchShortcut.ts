/**
 * Whether a keydown is the bare `/` that opens the command palette.
 *
 * Pulled out of `Navbar.jsx` so it can be asked the question directly. The
 * listener behind it is bound on `window`, and that is the whole reason the
 * modal check below exists: a modal dialog makes the rest of the page `inert`,
 * which stops clicks and focus but NOT a key event — focus is inside the
 * dialog, the keydown bubbles up to `window` all the same, and the palette
 * would open over the reader. Opening it there is not merely untidy: picking a
 * result navigates for real (`SearchCommand.jsx`), and a real navigation taken
 * while `useOverlayHistory` is armed strands its entry between two real routes
 * for good — one Back press that does nothing, once per occurrence, for the
 * rest of the session.
 *
 * `[aria-modal="true"]` is the probe this repo already uses for exactly this
 * (ui/dialog.jsx writes it; FeedContainer's arrow-key guard reads it).
 *
 * `closest` is duck-typed rather than gated on `instanceof Element` so the
 * question can be asked without a DOM; in a browser nothing but an Element
 * has it.
 */
export function shouldOpenSearchOnSlash(event, doc) {
  if (!event || event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (target && typeof target.closest === 'function'
    && target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  if (typeof doc?.querySelector === 'function' && doc.querySelector('[aria-modal="true"]')) return false;
  return true;
}
