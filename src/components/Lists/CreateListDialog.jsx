/**
 * The one window that creates a list.
 *
 * There used to be two. "Mis listas" grew a form inside the card of the grid —
 * icons at 16 px, a bare input, no header — while the save-and-organize modal
 * opened a proper window. They drifted apart in both directions: the card knew
 * how to say "it could not be created" and the window did not, so a failed
 * create in the modal printed to the console and left the owner staring at an
 * unchanged screen.
 *
 * This component owns the FORM and nothing else. Writing the list stays with
 * each caller, because the two writes genuinely differ: the lists page adds to
 * its own state, and the save modal also revises the session cache it keeps and
 * ticks the new list for the pending save. Keeping persistence out is what stops
 * the two from diverging again.
 *
 * A native <dialog>, and nested inside the save modal's own dialog when it is
 * opened from there. Escape lands on the topmost dialog only, so it folds this
 * window without touching the modal underneath or its unsaved-changes guard —
 * as long as the cancel and close events stop propagating, which React would
 * otherwise carry up the component tree to the parent dialog's handlers.
 */
import { useEffect, useReducer, useRef } from 'react';
import { X } from 'lucide-react';
import { AVAILABLE_ICONS, getIcon } from '../../utils/icons.js';
import { Button } from '../ui/button.jsx';
import {
  canSubmitCreateList,
  createListFormReducer,
  CREATE_LIST_FORM_INITIAL,
} from '../../utils/createListFormModel.js';
import './CreateListDialog.css';

const COPY = {
  en: {
    title: 'New list',
    close: 'Close',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Thesis reading',
    iconLabel: 'Icon',
    privacyNote: 'It starts private. Publish it from My lists once it has content.',
    create: 'Create',
    creating: 'Creating...',
    cancel: 'Cancel',
    error: 'It could not be created. Try again.',
  },
  es: {
    title: 'Nueva lista',
    close: 'Cerrar',
    nameLabel: 'Nombre',
    namePlaceholder: 'p. ej. Lecturas de tesis',
    iconLabel: 'Icono',
    privacyNote: 'Nace privada. Publícala desde Mis listas cuando tenga contenido.',
    create: 'Crear',
    creating: 'Creando...',
    cancel: 'Cancelar',
    error: 'No se pudo crear. Inténtalo de nuevo.',
  },
};

/**
 * `onCreate(name, icon)` belongs to the caller and is expected to throw when
 * the list could not be written. Resolving closes the window; throwing keeps it
 * open and shows the error — which is the whole of what the save modal needed
 * to stop failing in silence.
 */
export default function CreateListDialog({ open, isEnglish = false, onClose, onCreate }) {
  const [state, dispatch] = useReducer(createListFormReducer, CREATE_LIST_FORM_INITIAL);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  // A ref rather than `state.busy`: two Enters can land before React re-renders,
  // and both would read a stale `busy: false` and write two lists.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    inFlight.current = false;
    dispatch({ type: 'open' });
    // Explicitly, and not with `autoFocus`: showModal() runs from the ref
    // callback, which is early enough to leave the caret on <body> — a keyboard
    // user would open this window with nothing focused inside it and Tab from
    // the top of the document. An effect runs after the commit, so by here the
    // field exists and the dialog is already modal.
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const copy = isEnglish ? COPY.en : COPY.es;

  /**
   * Every close path lands here, so none of them can abandon a write midway.
   *
   * `.close()` before the parent unmounts us, always: the platform hands focus
   * back to the button that opened the dialog when it is closed, and not when
   * it is merely removed from the document. Dropping it would leave the caret
   * nowhere after every cancel.
   */
  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const requestClose = () => {
    if (!inFlight.current) close();
  };

  const submit = async () => {
    if (inFlight.current || !canSubmitCreateList(state)) return;
    inFlight.current = true;
    dispatch({ type: 'submit' });
    try {
      await onCreate(state.name.trim(), state.icon);
      inFlight.current = false;
      close();
    } catch {
      inFlight.current = false;
      dispatch({ type: 'failed' });
    }
  };

  return (
    <dialog
      ref={(node) => {
        dialogRef.current = node;
        if (node && !node.open) node.showModal();
      }}
      className="create-list-dialog"
      aria-label={copy.title}
      onCancel={(event) => {
        // stopPropagation matters: React carries the synthetic cancel up the
        // component tree, and a parent dialog's onCancel would close that too.
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onClose={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="create-list-card">
        <div className="create-list-header">
          <h3>{copy.title}</h3>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={requestClose}
            aria-label={copy.close}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        <label className="create-list-field">
          <span>{copy.nameLabel}</span>
          <input
            type="text"
            className="create-list-input"
            placeholder={copy.namePlaceholder}
            ref={inputRef}
            value={state.name}
            maxLength={80}
            onChange={(event) => dispatch({ type: 'name', value: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
        </label>

        <div className="create-list-field">
          <span id="create-list-icon-label">{copy.iconLabel}</span>
          <div
            className="create-list-icon-picker"
            role="radiogroup"
            aria-labelledby="create-list-icon-label"
          >
            {AVAILABLE_ICONS.map((iconName) => {
              const Icon = getIcon(iconName);
              return (
                <button
                  key={iconName}
                  type="button"
                  role="radio"
                  aria-checked={state.icon === iconName}
                  aria-label={iconName}
                  className={`create-list-icon-btn${state.icon === iconName ? ' is-active' : ''}`}
                  onClick={() => dispatch({ type: 'icon', value: iconName })}
                >
                  <Icon size={22} strokeWidth={1.5} />
                </button>
              );
            })}
          </div>
        </div>

        <p className="create-list-note">{copy.privacyNote}</p>

        {state.error && (
          <p className="create-list-error" role="alert">{copy.error}</p>
        )}

        <div className="create-list-actions">
          <Button variant="outline" onClick={requestClose}>
            {copy.cancel}
          </Button>
          <Button onClick={submit} disabled={!canSubmitCreateList(state)}>
            {state.busy ? copy.creating : copy.create}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
