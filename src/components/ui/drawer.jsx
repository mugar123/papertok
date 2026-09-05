import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import { cn } from '../../lib/utils.js';
import './drawer.css';

/**
 * The bottom sheet a thumb dismisses — Base UI's Drawer: a Dialog plus
 * swipe-to-dismiss, snap points and the swipe-progress variables its
 * stylesheet reads. Comments, the follow sheet, related papers, the authors
 * sheet: anything that arrives from the bottom of a phone and should leave
 * the same way, by hand or by gesture. For a panel with no gesture, Sheet.
 *
 * The one stylesheet in `ui/` (drawer.css): the swipe follows `calc()` over
 * Base UI's `--drawer-swipe-*` variables, and that is a paragraph of CSS,
 * not a class name. Everything visual still comes from the tokens.
 *
 * `swipeDirection` defaults to the side the drawer sits on. Text inside
 * `DrawerContent` stays selectable with a mouse; add
 * `data-base-ui-swipe-ignore` to a scrolling region that must not dismiss.
 */
function Drawer({ side = 'bottom', swipeDirection, ...props }) {
  return (
    <DrawerPrimitive.Root
      data-slot="drawer"
      swipeDirection={swipeDirection ?? { bottom: 'down', top: 'up', left: 'left', right: 'right' }[side]}
      {...props}
    />
  );
}

function DrawerTrigger(props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal(props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose(props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({ className, ...props }) {
  return <DrawerPrimitive.Backdrop data-slot="drawer-overlay" className={cn('ui-drawer-backdrop', className)} {...props} />;
}

/**
 * `viewportClassName` reaches the positioning container; `className` the
 * popup itself (the visible sheet). A drawer without `snapPoints` opens at
 * its content height, capped at 85dvh with its own inside scroll.
 */
function DrawerContent({ className, viewportClassName, overlayClassName, side = 'bottom', children, ...props }) {
  return (
    <DrawerPortal>
      <DrawerOverlay className={overlayClassName} />
      <DrawerPrimitive.Viewport data-slot="drawer-viewport" data-side={side} className={cn('ui-drawer-viewport', viewportClassName)}>
        <DrawerPrimitive.Popup
        aria-modal="true"
          data-slot="drawer-content"
          data-side={side}
          className={cn('ui-drawer-popup outline-none', className)}
          {...props}
        >
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

/* The grab handle: decorative, the gesture works on the whole popup. */
function DrawerHandle({ className, ...props }) {
  return <div data-slot="drawer-handle" aria-hidden="true" className={cn('ui-drawer-handle', className)} {...props} />;
}

/* Text selection works inside this part without starting a swipe. */
function DrawerBody({ className, ...props }) {
  return <DrawerPrimitive.Content data-slot="drawer-body" className={cn('ui-drawer-body', className)} {...props} />;
}

function DrawerHeader({ className, ...props }) {
  return <div data-slot="drawer-header" className={cn('flex flex-col gap-1 px-5 pt-2 pb-3', className)} {...props} />;
}

function DrawerFooter({ className, ...props }) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('font-serif text-[1.25rem] font-semibold leading-tight tracking-[-0.01em] text-foreground', className)}
      {...props}
    />
  );
}

function DrawerDescription({ className, ...props }) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-[0.8125rem] leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHandle,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
