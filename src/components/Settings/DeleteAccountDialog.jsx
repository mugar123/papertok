import { useId, useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import { deleteAccount } from '../../services/accountDeletionService.js';
import { getUiErrorMessage } from '../../utils/errorMessages';
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

export default function DeleteAccountDialog({ open, language, onClose, onDeleted }) {
  const copy = COPY[language === 'en' ? 'en' : 'es'];
  const titleId = useId();
  const leadId = useId();
  const inputId = useId();
  const errorId = useId();
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogFocus(open, working ? null : onClose);

  if (!open) return null;

  const confirmed = typed.trim() === copy.phrase;

  const handleClose = () => {
    if (working) return;
    setTyped('');
    setError('');
    onClose();
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
    <div className="delete-account-backdrop">
      <div
        ref={dialogRef}
        className="delete-account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        aria-busy={working ? 'true' : undefined}
        tabIndex={-1}
      >
        <button
          type="button"
          className="delete-account-close"
          onClick={handleClose}
          disabled={working}
          aria-label={copy.close}
        >
          <X size={18} />
        </button>
        <h2 id={titleId}>{copy.title}</h2>
        <p id={leadId}>{copy.lead}</p>
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
          <label htmlFor={inputId}>{copy.typeLabel}</label>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck="false"
            value={typed}
            disabled={working}
            onChange={(event) => setTyped(event.target.value)}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? errorId : undefined}
            data-dialog-initial-focus=""
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
          <button type="button" className="delete-account-cancel" onClick={handleClose} disabled={working}>
            {copy.cancel}
          </button>
          <button
            type="button"
            className="delete-account-confirm"
            onClick={handleDelete}
            disabled={!confirmed || working}
          >
            {working ? <LoaderCircle className="delete-account-spinner" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
