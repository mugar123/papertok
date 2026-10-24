import type { ComponentProps } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { CircleNotch, Trash, X } from '@phosphor-icons/react';
import { deleteAccount } from '../../services/account-deletion-service.ts';
import { reauthenticateCurrentUser } from '../../services/auth-identity-service.ts';
import { popupReadiness } from '../../services/firebase.ts';
import usePopupReady from '../../hooks/use-popup-ready.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog.tsx';
import { Button } from '../ui/button.tsx';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import { deleteConfirmedAccount } from './delete-confirmed-account.ts';
import './delete-account-dialog.css';

const COPY = {
  en: {
    title: 'Delete account',
    close: 'Close',
    lead: 'This deletes your lists, highlights, plain-words summaries, follows, preferences, newsletter subscription, and sign-in account, along with any profile, photo, comments or content reports from earlier versions of PaperTok. It cannot be undone. Before anything is deleted, a new window asks you to sign in again.',
    privacy: 'Privacy policy',
    privacyNewTab: 'opens in a new tab',
    typeLabel: 'Type DELETE to confirm',
    phrase: 'DELETE',
    confirm: 'Delete my account',
    signingIn: 'Sign in again in the new window to continue.',
    preparing: 'Preparing sign-in…',
    working: 'Deleting the account…',
    cancel: 'Cancel',
  },
};

function DrawerCancel({ variant = 'outline', ...props }: ComponentProps<typeof DrawerClose> & Pick<ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return <DrawerClose render={<Button variant={variant} />} {...props} />;
}

/**
 * An alert dialog (`role="alertdialog"`): the scrim does not dismiss it, the
 * answer has to be Cancel, the X, Escape, or the typed phrase. SettingsPage
 * mounts it only while it is wanted, so it opens on mount and owns its
 * `open` flag; Base UI plays the leave and then `onOpenChangeComplete(false)`
 * is the one call to the parent's `onClose`. While the deletion runs nothing
 * closes it: the outcome is either `onDeleted` or an error to read. On a
 * phone it is a bottom Drawer with the same rules: the scrim does not
 * dismiss it, and nothing does while the deletion runs.
 */
export default function DeleteAccountDialog({ open: openOnMount = true, onClose, onDeleted }: { open?: boolean; onClose: () => void; onDeleted: () => void | Promise<void>; language?: string }) {
  const copy = COPY['en'];
  const inputId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(openOnMount);
  const [typed, setTyped] = useState('');
  // '' when idle, 'signingIn' while the sign-in popup is open, then 'deleting'.
  const [step, setStep] = useState<'' | 'signingIn' | 'deleting'>('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isPhone = useIsPhone();
  const Cancel = isPhone ? DrawerCancel : AlertDialogCancel;
  const Title = isPhone ? DrawerTitle : AlertDialogTitle;
  const Description = isPhone ? DrawerDescription : AlertDialogDescription;

  const confirmed = typed.trim() === copy.phrase;
  const working = step !== '';
  // Until the sign-in window can open inside the press (usePopupReady), a
  // confirmed delete waits, focusable and described by the status line.
  const popupReady = usePopupReady(popupReadiness);
  const held = confirmed && !popupReady;

  // The input and buttons are disabled while the sign-in window and the
  // deletion run, so focus falls out of the dialog. On an error it goes back to
  // the input, which the error is attached to.
  useEffect(() => {
    if (error && !working) inputRef.current?.focus();
  }, [error, working]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (working) return;
    setOpen(nextOpen);
  };

  const handleOpenChangeComplete = (isOpen: boolean) => {
    if (!isOpen) onClose();
  };

  // The Worker deletes nothing for a sign-in that is not recent, so the person
  // signs in again first. That popup has to open from this click, before any
  // other `await`, or the browser blocks it.
  const handleDelete = async () => {
    if (!confirmed || working || held) return;
    setStep('signingIn');
    setError('');
    try {
      await deleteConfirmedAccount({
        reauthenticate: reauthenticateCurrentUser,
        onSignedIn: () => setStep('deleting'),
        deleteAccount,
        onDeleted,
      });
    } catch (err) {
      setError(getUiErrorMessage(err, 'ACCOUNT_DELETION_FAILED'));
      setStep('');
    }
  };

  const content = (
    <>
      <Cancel
        variant="ghost"
        size="icon-sm"
        className="delete-account-close"
        disabled={working}
        aria-label={copy.close}
      >
        <X size={18} />
      </Cancel>
      <Title>{copy.title}</Title>
      <Description>{copy.lead}</Description>
      <p>
        <a
          href="/privacy.html"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${copy.privacy} (${copy.privacyNewTab})`}
        >
          {copy.privacy}
        </a>
      </p>
      <div className="delete-account-field">
        <Label htmlFor={inputId}>{copy.typeLabel}</Label>
        <Input
          ref={inputRef}
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck="false"
          value={typed}
          disabled={working}
          onChange={(event) => setTyped(event.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      <p
        id={errorId}
        className={`delete-account-status${working || held ? ' is-working' : ''}`}
        role="status"
        aria-live="polite"
      >
        {step === 'signingIn' && copy.signingIn}
        {step === 'deleting' && copy.working}
        {held && copy.preparing}
        {error}
      </p>
      <div className="delete-account-actions">
        <Cancel disabled={working}>
          {copy.cancel}
        </Cancel>
        <Button
          variant="outline"
          className="delete-account-confirm"
          onClick={() => { void handleDelete(); }}
          disabled={!confirmed || working || held}
          focusableWhenDisabled={held}
          aria-describedby={held ? errorId : undefined}
        >
          {working || held ? <CircleNotch className="delete-account-spinner" size={16} aria-hidden="true" /> : <Trash size={16} aria-hidden="true" />}
          {copy.confirm}
        </Button>
      </div>
    </>
  );

  if (isPhone) {
    return (
      <Drawer
        open={open}
        onOpenChange={handleOpenChange}
        onOpenChangeComplete={handleOpenChangeComplete}
        disablePointerDismissal
      >
        <DrawerContent
          role="alertdialog"
          className="settings-sheet delete-account-sheet"
          overlayClassName="settings-sheet-backdrop"
          aria-busy={working ? 'true' : undefined}
          initialFocus={inputRef}
        >
          <DrawerHandle />
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
    >
      <AlertDialogContent
        className="delete-account-dialog"
        overlayClassName="delete-account-backdrop"
        aria-busy={working ? 'true' : undefined}
        initialFocus={inputRef}
      >
        {content}
      </AlertDialogContent>
    </AlertDialog>
  );
}
