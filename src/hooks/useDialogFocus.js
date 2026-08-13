import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const dialogStack = [];

export function useDialogFocus(open, onClose) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const restoreFocusRef = useRef(null);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return undefined;
    dialogStack.push(dialog);
    const isTopDialog = () => dialogStack.at(-1) === dialog;

    if (!restoreFocusRef.current && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    const getFocusable = () => Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
    const focusInitial = () => {
      if (!isTopDialog()) return;
      const target = dialog.querySelector('[data-dialog-initial-focus]') || getFocusable()[0] || dialog;
      target.focus({ preventScroll: true });
    };
    const focusFrame = requestAnimationFrame(focusInitial);

    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape' && closeRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const keepFocusInside = (event) => {
      if (!isTopDialog()) return;
      if (!dialog.contains(event.target)) focusInitial();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', keepFocusInside);
      const stackIndex = dialogStack.lastIndexOf(dialog);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const parentDialog = dialogStack.at(-1);
      if (parentDialog) {
        const parentFocus = restoreTarget?.isConnected && parentDialog.contains(restoreTarget)
          ? restoreTarget
          : parentDialog.querySelector(FOCUSABLE_SELECTOR) || parentDialog;
        parentFocus.focus({ preventScroll: true });
      } else if (restoreTarget?.isConnected) {
        restoreTarget.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return dialogRef;
}
