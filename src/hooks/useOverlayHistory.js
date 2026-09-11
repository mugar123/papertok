import { useEffect, useRef } from 'react';

/**
 * A reader or a PDF viewer is local component state rendered through a
 * portal, not a route — it pushes nothing onto session history. Pressing
 * Back while one is open therefore does not close it; it leaves PaperTok
 * entirely, straight to whatever the visitor had open before (the tester's
 * report). HashRouter cannot help on its own: it reads the URL, and none of
 * these three overlays (PaperCard's reader, App's PDF viewer, EntityExplorer's
 * own PDF viewer) change it.
 *
 * The fix borrows a history entry instead of a route. `arm()` clones
 * react-router's own `history.state` — keeping `usr`, `key` and, deliberately,
 * `idx` — and tags it with `overlay`. A raw `pushState` fires no event, so
 * nothing else in the app notices; a `popstate` (Back) is the only thing that
 * can ever undo it, so `arm()` starts listening for exactly that. When it
 * fires, the browser has already popped the entry, and the only thing left to
 * do is tell React the overlay closed. `disarm()` is the mirror case: the
 * user closed with the X, so the entry has to be removed by hand
 * (`history.back()`) or it sits behind as a phantom stop a later Back would
 * have to click through before it reached anything real.
 *
 * That removal is not free, and the design is not leak-free: `history.back()`
 * does not DELETE the entry it steps off, it only moves off it. So after a
 * close with the X the tagged entry survives as a forward entry, and a visitor
 * who presses Forward lands on it — same URL, no overlay, nothing armed, and
 * one Back press that appears to do nothing before they are moving again. No
 * web API can remove a session-history entry; only a later real navigation
 * truncates the forward list, which is what happens in practice the moment
 * they touch anything in the app. It is the cost of borrowing an entry instead
 * of owning a route, it is bounded at one dead press, and it is written down
 * here rather than presented as absent.
 *
 * `idx` is cloned, never incremented, so the pushed entry carries the SAME
 * idx as the route beneath it. That is what makes it safe rather than a
 * landmine: `routeDirection.js`, `usePageTransitionCustom.js` and the
 * `goBack`/`handleBack` helpers in `PublicPaperPage.jsx` and
 * `EntityExplorer.jsx` all read `window.history.state.idx` fresh, on demand,
 * and react-router's own `push()` computes the NEXT index the same way —
 * `getIndex() + 1`, read live off the DOM state, never off a remembered
 * counter (`getUrlBasedHistory` in react-router's history module). A real
 * navigation that happens with an overlay entry on top computes
 * `current_idx + 1` exactly as if the overlay entry were not there, because
 * pushState raised no event for anything to have observed it by. The
 * sequence `directionForHistoryIndex` sees stays unbroken — idx=k (real),
 * idx=k+1 (real) — with the overlay's own idx=k entry invisible in between.
 *
 * `onPop` does not check that the entry it landed on still names `tag`. No
 * two of these three overlays can be open at once through the UI to begin
 * with: PaperReader, PDFViewer and EntityExplorer's own PDF dialog are each a
 * modal Base UI Dialog, and a modal dialog makes the rest of the page —
 * including whatever would open a second one — inert while it is open
 * (confirmed by reading each: PaperReader has no PDF affordance and no
 * `navigate()` of its own). So the only real question left is "did Back just
 * undo my own push", and treating any pop while armed as "close me" resolves
 * toward the overlay closing rather than staying open over a URL that no
 * longer backs it — the failure direction this hook has to prefer, per
 * "never trap the user".
 *
 * What `onClose` must BE: the overlay's own close request — the function its X
 * and Escape already travel through (`requestClose` in PaperReader,
 * `handleClose` in PDFViewer) — never the parent's unmount switch. Both
 * overlays own their `open` internally and call the parent back only from
 * `onOpenChangeComplete(false)`, so unmounting them straight from here would
 * tear the node out with `open` still true: the leave animation is cut, and
 * Base UI never unwinds what a modal took — the scroll lock, `inert` and
 * `aria-hidden` on everything behind it. A visitor would be left looking at a
 * live page they cannot scroll or click, trapped by a different mechanism than
 * the one this hook exists to unblock. Back and the X have to end up in the
 * same function; the three owners hand this hook exactly that (a `closeRef`
 * the overlay publishes into, with the unmount switch kept only as the
 * fallback for the window before the lazy chunk has mounted).
 */
export function createOverlayHistory({ history, listen, unlisten }) {
  let armed = null;
  const onPop = () => {
    if (!armed) return;
    const { onClose } = armed; armed = null; unlisten(onPop);
    onClose();
  };
  return {
    arm(tag, onClose) {
      if (armed) return;
      // Already sitting on an entry tagged for this same overlay: arming
      // again must not stack an indistinguishable second one on top of it —
      // Back would then have to be pressed twice before it reached anything
      // real, and the stack would grow by one every time this happens. The
      // ordinary way to reach this line is a disarmed hook told to arm again
      // before its own `history.back()` — asynchronous in every real
      // browser — has actually popped the first entry.
      const alreadyOnTag = Boolean(history.state) && history.state.overlay === tag;
      if (!alreadyOnTag) {
        try {
          history.pushState(
            { ...(history.state || {}), overlay: tag },
            '',
            typeof location !== 'undefined' ? location.href : undefined,
          );
        } catch {
          // Safari throws SecurityError past ~100 pushes in 30 s, which is why
          // react-router wraps its own `pushState` too (its history module's
          // `push()`). This one runs inside a bare `requestAnimationFrame`
          // callback with no React boundary above it, so an escaping throw
          // would be an unhandled error. Declining to arm is the only safe
          // reading of it: there is no entry to pop, so arming would leave
          // `disarm()` eating a REAL one. The cost is that this one Back press
          // leaves PaperTok, exactly as it did before this hook existed —
          // worse than closing the overlay, but never a trap and never a
          // stolen navigation.
          return;
        }
      }
      armed = { tag, onClose };
      listen(onPop);
    },
    disarm() {
      if (!armed) return;
      const { tag } = armed; armed = null; unlisten(onPop);
      // Only step back if the entry on top is still the one this arm() call
      // made. If a real Back already consumed it, `onPop` above already ran
      // and closed the overlay; stepping back a second time here would eat
      // the entry the user actually meant to leave.
      if (history.state?.overlay === tag) history.back();
    },
  };
}

/**
 * A reload with an overlay open leaves its tagged entry behind: the marker is
 * written into `history.state`, and react-router only ever rewrites that state
 * when `idx == null` (its history module, `getUrlBasedHistory`), which a cloned
 * entry never is. So the tag outlives the component it described — the reader
 * is gone with the rest of the component state, but the state object still
 * claims one is open. Left there it lies to the next `arm()`: `alreadyOnTag`
 * would see its own tag on an entry it did not push, skip the push, and then
 * let `disarm()` step back over an entry that belongs to nobody.
 *
 * `main.jsx` calls this once, before React renders, when nothing can be armed
 * yet. It only clears the marker: the duplicate ENTRY itself cannot be removed
 * without `history.back()`, and a `back()` at boot is the wrong trade. The
 * entry below a marked one always carries the same URL (the clone is pushed
 * with `location.href`), but after a reload its document is gone, so traversing
 * to it is a fresh load of that URL, not a same-document hop: the app would
 * boot, immediately reload itself, and boot again. It would also be a
 * navigation nobody asked for — the marked entry can be one the visitor
 * reached by pressing FORWARD (see the note on `disarm()` above). What is left
 * after clearing is one Back press that lands on an identical URL and so looks
 * like it did nothing: on `/explorer/*` and `/public/paper/*` the in-page back
 * arrow inherits that, once, after a reload taken with an overlay open.
 */
export function clearStaleOverlayMarker({ history, location }) {
  const state = history?.state;
  if (!state || typeof state !== 'object' || state.overlay === undefined) return false;
  const cleaned = { ...state };
  delete cleaned.overlay;
  try {
    history.replaceState(cleaned, '', location?.href);
  } catch {
    return false;
  }
  return true;
}

/**
 * `open` arms and disarms one `createOverlayHistory` instance, kept in a ref
 * so the entry is pushed on the open/close edges only, never on every render.
 *
 * The push itself waits a frame (`requestAnimationFrame`), the same dodge
 * `usePopupOpenOnMount.js` uses against the same cause: React 18 StrictMode
 * (`main.jsx`) mounts, cleans up and remounts every effect once, synchronously,
 * in development (see `RouteAnnouncer.jsx` for another place this repo already
 * accounts for it). Without the frame, that dance would arm, disarm — queuing
 * a real `history.back()` that has not fired yet — and arm again, all before
 * the browser ever processes the queued pop; when it finally did, it would
 * land on the second arm's entry and close an overlay the user never asked to
 * close. Deferred a frame, StrictMode's first arm never runs at all — its
 * `cancelAnimationFrame` in cleanup beats the callback to it — and only the
 * surviving, real mount ever touches history. A close within that single
 * frame is not reachable by a person; nothing here is slower for one.
 */
export function useOverlayHistory(open, onClose, tag) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  const ctlRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    if (!ctlRef.current) {
      ctlRef.current = createOverlayHistory({
        history: window.history,
        listen: (fn) => window.addEventListener('popstate', fn),
        unlisten: (fn) => window.removeEventListener('popstate', fn),
      });
    }
    const ctl = ctlRef.current;
    const frame = requestAnimationFrame(() => ctl.arm(tag, () => closeRef.current()));
    return () => {
      cancelAnimationFrame(frame);
      ctl.disarm();
    };
  }, [open, tag]);
}
