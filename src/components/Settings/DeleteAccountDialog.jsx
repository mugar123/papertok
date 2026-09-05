import { useId, useRef, useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';
import { deleteAccount } from '../../services/accountDeletionService.js';
import { getUiErrorMessage } from '../../utils/errorMessages';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog.jsx';
import { Button } from '../ui/button.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import './DeleteAccountDialog.css';

const COPY = {
  es: {
    title: 'Eliminar cuenta',
    close: 'Cerrar',
    lead: 'Esto borra tu perfil, tus listas, tus subrayados, tus seguimientos, tus preferencias, la suscripción al boletín y la cuenta de acceso. No se puede deshacer.',
    comments: 'Tus comentarios permanecen en los hilos, firmados como cuenta eliminada, para no romper conversaciones ajenas.',
    privacy: 'Política de privacidad',
    privacyNewTab: 'se abre en una pestaña nueva',
    typeLabel: 'Escribe ELIMINAR para confirmar',
    phrase: 'ELIMINAR',
    confirm: 'Eliminar mi cuenta',
    working: 'Eliminando la cuenta…',
    cancel: 'Cancelar',
  },
  en: {
    title: 'Delete account',
    close: 'Close',
    lead: 'This deletes your profile, lists, highlights, follows, preferences, newsletter subscription, and sign-in account. It cannot be undone.',
    comments: 'Your comments stay in their threads, signed as a deleted account, so other people’s conversations are not broken.',
    privacy: 'Privacy policy',
    privacyNewTab: 'opens in a new tab',
    typeLabel: 'Type DELETE to confirm',
    phrase: 'DELETE',
    confirm: 'Delete my account',
    working: 'Deleting the account…',
    cancel: 'Cancel',
  },
};

/**
 * An alert dialog (`role="alertdialog"`): the scrim does not dismiss it, the
 * answer has to be Cancel, the X, Escape, or the typed phrase. SettingsPage
 * mounts it only while it is wanted, so it opens on mount and owns its
 * `open` flag; Base UI plays the leave and then `onOpenChangeComplete(false)`
 * is the one call to the parent's `onClose`. While the deletion runs nothing
 * closes it: the outcome is either `onDeleted` or an error to read.
 */
export default function DeleteAccountDialog({ open: openOnMount = true, language, onClose, onDeleted }) {
  const copy = COPY[language === 'en' ? 'en' : 'es'];
  const inputId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(openOnMount);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const confirmed = typed.trim() === copy.phrase;

  const handleOpenChange = (nextOpen) => {
    if (working) return;
    setOpen(nextOpen);
  };

  const handleDelete = async () => {
    if (!confirmed || working) return;
    setWorking(true);
    setError('');
    try {
      await deleteAccount();
      await onDeleted();
    } catch (err) {
      setError(getUiErrorMessage(err, language, 'ACCOUNT_DELETION_FAILED'));
      setWorking(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={(isOpen) => { if (!isOpen) onClose(); }}
    >
      <AlertDialogContent
        className="delete-account-dialog"
        overlayClassName="delete-account-backdrop"
        aria-busy={working ? 'true' : undefined}
        initialFocus={inputRef}
      >
        <AlertDialogCancel
          variant="ghost"
          size="icon-sm"
          className="delete-account-close"
          disabled={working}
          aria-label={copy.close}
        >
          <X size={18} />
        </AlertDialogCancel>
        <AlertDialogTitle>{copy.title}</AlertDialogTitle>
        <AlertDialogDescription>{copy.lead}</AlertDialogDescription>
        <p>{copy.comments}</p>
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
          className={`delete-account-status${working ? ' is-working' : ''}`}
          role="status"
          aria-live="polite"
        >
          {working ? copy.working : error}
        </p>
        <div className="delete-account-actions">
          <AlertDialogCancel disabled={working}>
            {copy.cancel}
          </AlertDialogCancel>
          <Button
            variant="outline"
            className="delete-account-confirm"
            onClick={handleDelete}
            disabled={!confirmed || working}
          >
            {working ? <LoaderCircle className="delete-account-spinner" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
            {copy.confirm}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
