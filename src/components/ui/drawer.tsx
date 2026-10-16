import type { StyledProps } from './props.ts';
import type { ComponentProps } from 'react';

import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import { cn } from '../../lib/utils.ts';
import './drawer.css';

/**
 * The bottom sheet a thumb dismisses — Base UI's Drawer: a Dialog plus
 * swipe-to-dismiss, snap points and the swipe-progress variables its
 * stylesheet reads. The account sheet, related papers, the authors sheet:
 * anything that arrives from the bottom of a phone and should leave the same
 * way, by hand or by gesture. For a panel with no gesture, Sheet.
 *
 * The one stylesheet in `ui/` (drawer.css): the swipe follows `calc()` over
 * Base UI's `--drawer-swipe-*` variables, and that is a paragraph of CSS,
 * not a class name. Everything visual still comes from the tokens.
 *
 * `swipeDirection` defaults to the side the drawer sits on. Text inside
 * `DrawerContent` stays selectable with a mouse; add
 * `data-base-ui-swipe-ignore` to a scrolling region that must not dismiss.
 */
function Drawer({ side = 'bottom', swipeDirection, ...props }: ComponentProps<typeof DrawerPrimitive.Root> & { side?: 'bottom' | 'top' | 'left' | 'right' }) {
  return (
    <DrawerPrimitive.Root
      data-slot="drawer"
      swipeDirection={swipeDirection ?? ({ bottom: 'down', top: 'up', left: 'left', right: 'right' } as const)[side]}
      {...props}
    />
  );
}

/* Opens the drawer; Base UI gives it aria-expanded and returns focus to it on close. */
function DrawerTrigger(props: ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal(props: ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose(props: ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({ className, ...props }: StyledProps<typeof DrawerPrimitive.Backdrop>) {
  return <DrawerPrimitive.Backdrop data-slot="drawer-overlay" className={cn('ui-drawer-backdrop', className)} {...props} />;
}

/**
 * `viewportClassName` reaches the positioning container; `className` the
 * popup itself (the visible sheet). A drawer without `snapPoints` opens at
 * its content height, capped at 85dvh with its own inside scroll.
 */
function DrawerContent({ className, viewportClassName, overlayClassName, side = 'bottom', children, ...props }: StyledProps<typeof DrawerPrimitive.Popup> & { viewportClassName?: string; overlayClassName?: string; side?: 'bottom' | 'top' | 'left' | 'right' }) {
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
function DrawerHandle({ className, ...props }: StyledProps<'div'>) {
  return <div data-slot="drawer-handle" aria-hidden="true" className={cn('ui-drawer-handle', className)} {...props} />;
}

/* Text selection works inside this part without starting a swipe. */
function DrawerBody({ className, ...props }: StyledProps<typeof DrawerPrimitive.Content>) {
  return <DrawerPrimitive.Content data-slot="drawer-body" className={cn('ui-drawer-body', className)} {...props} />;
}

function DrawerTitle({ className, ...props }: StyledProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('font-serif text-[1.25rem] font-semibold leading-tight tracking-[-0.01em] text-foreground', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerHandle,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
