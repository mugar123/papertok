/**
 * Whether a keydown opens the command palette: the bare `/`, or ⌘K on a Mac
 * and Ctrl+K elsewhere (either modifier is taken on any platform). The chord
 * works from inside a field too, as it does in every app that has one; the
 * bare `/` does not, because there it is a character being typed.
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
  if (!event) return false;
  const chord = String(event.key).toLowerCase() === 'k'
    && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
  const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (!chord && !slash) return false;
  const target = event.target;
  if (slash && target && typeof target.closest === 'function'
    && target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  if (typeof doc?.querySelector === 'function' && doc.querySelector('[aria-modal="true"]')) return false;
  return true;
}
