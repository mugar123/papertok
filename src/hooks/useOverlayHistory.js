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
        history.pushState(
          { ...(history.state || {}), overlay: tag },
          '',
          typeof location !== 'undefined' ? location.href : undefined,
        );
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
  closeRef.current = onClose;
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
