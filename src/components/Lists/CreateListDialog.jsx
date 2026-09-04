/**
 * The one window that creates a list — and, since the palette landed, the one
 * that edits it.
 *
 * There used to be two. "Mis listas" grew a form inside the card of the grid —
 * icons at 16 px, a bare input, no header — while the save-and-organize modal
 * opened a proper window. They drifted apart in both directions: the card knew
 * how to say "it could not be created" and the window did not, so a failed
 * create in the modal printed to the console and left the owner staring at an
 * unchanged screen.
 *
 * Editing is the same three fields as creating, so it is the same window with
 * `list` passed in rather than a second one: a separate editor is how the pair
 * above drifted, and there is no reason to run that experiment twice.
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
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { AVAILABLE_ICONS, getIcon } from '../../utils/icons.js';
import { Button } from '../ui/button.jsx';
import {
  canSubmitCreateList,
  createListFormReducer,
  CREATE_LIST_FORM_INITIAL,
} from '../../utils/createListFormModel.js';
import { LIST_COLORS, randomListColorId, resolveListColorId } from '../../utils/listColors.js';
import './CreateListDialog.css';

/** Kept in step with the exit animation in CreateListDialog.css. */
const DIALOG_EXIT_MS = 160;

const COPY = {
  en: {
    title: 'New list',
    editTitle: 'Edit list',
    close: 'Close',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Thesis reading',
    iconLabel: 'Icon',
    colorLabel: 'Colour',
    colorHint: 'One is picked at random when the list is created. Change it here or later.',
    colorHintEdit: 'Choose one of the eight in the palette.',
    privacyNote: 'It starts private. Publish it from My lists once it has content.',
    create: 'Create',
    creating: 'Creating...',
    save: 'Save',
    saving: 'Saving...',
    cancel: 'Cancel',
    error: 'It could not be created. Try again.',
    editError: 'It could not be saved. Try again.',
    colors: {
      ochre: 'Ochre',
      olive: 'Olive',
      green: 'Green',
      teal: 'Teal',
      blue: 'Blue',
      indigo: 'Indigo',
      violet: 'Violet',
      crimson: 'Crimson',
    },
  },
  es: {
    title: 'Nueva lista',
    editTitle: 'Editar lista',
    close: 'Cerrar',
    nameLabel: 'Nombre',
    namePlaceholder: 'p. ej. Lecturas de tesis',
    iconLabel: 'Icono',
    colorLabel: 'Color',
    colorHint: 'Se asigna uno al azar al crear la lista. Cámbialo aquí o más tarde.',
    colorHintEdit: 'Elige uno de los ocho de la paleta.',
    privacyNote: 'Nace privada. Publícala desde Mis listas cuando tenga contenido.',
    create: 'Crear',
    creating: 'Creando...',
    save: 'Guardar',
    saving: 'Guardando...',
    cancel: 'Cancelar',
    error: 'No se pudo crear. Inténtalo de nuevo.',
    editError: 'No se pudo guardar. Inténtalo de nuevo.',
    colors: {
      ochre: 'Ocre',
      olive: 'Oliva',
      green: 'Verde',
      teal: 'Turquesa',
      blue: 'Azul',
      indigo: 'Índigo',
      violet: 'Violeta',
      crimson: 'Granate',
    },
  },
};

/**
 * `onCreate(name, icon, color)` and `onSave(listId, { name, icon, color })`
 * belong to the caller and are expected to throw when the write did not land.
 * Resolving closes the window; throwing keeps it open and shows the error —
 * which is the whole of what the save modal needed to stop failing in silence.
 *
 * Passing `list` puts the window in edit mode; leaving it out creates.
 */
export default function CreateListDialog({
  open,
  isEnglish = false,
  list = null,
  onClose,
  onCreate,
  onSave,
}) {
  const [state, dispatch] = useReducer(createListFormReducer, CREATE_LIST_FORM_INITIAL);
  const [closing, setClosing] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const nameErrorId = useId();
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const closeTimer = useRef(null);
  // A ref rather than `state.busy`: two Enters can land before React re-renders,
  // and both would read a stale `busy: false` and write two lists.
  const inFlight = useRef(false);

  const editing = Boolean(list);
  const { id: listId, name: listName, emoji: listIcon } = list ?? {};
  // Not `list.color`: a list made before the palette existed has none, and the
  // card is already painting it with the colour derived from its id. The picker
  // has to tick that one, or opening the editor silently offers to change a
  // colour the owner never sees as current.
  const listColor = editing ? resolveListColorId(list) : null;

  // Leaving the screen mid-exit must not leave a timer holding a `.close()` and
  // an `onClose` for a window that no longer exists.
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    inFlight.current = false;
    dispatch({
      type: 'open',
      preset: editing
        ? { name: listName, icon: listIcon, color: listColor }
        : { color: randomListColorId() },
    });
    // Explicitly, and not with `autoFocus`: showModal() runs from the ref
    // callback, which is early enough to leave the caret on <body> — a keyboard
    // user would open this window with nothing focused inside it and Tab from
    // the top of the document. An effect runs after the commit, so by here the
    // field exists and the dialog is already modal.
    inputRef.current?.focus();
  }, [open, editing, listName, listIcon, listColor]);

  if (!open) return null;

  const copy = isEnglish ? COPY.en : COPY.es;

  /**
   * Every close path lands here, so none of them can abandon a write midway.
   *
   * `.close()` before the parent unmounts us, always: the platform hands focus
   * back to the button that opened the dialog when it is closed, and not when
   * it is merely removed from the document. Dropping it would leave the caret
   * nowhere after every cancel.
   *
   * The window has to survive its own exit animation, so the close is held for
   * the length of it and the card is marked on the way out. A TIMER decides
   * when that is over, not `animationend`: under `prefers-reduced-motion` the
   * animation is `none`, no `animationend` ever fires, and a window waiting for
   * one would never close at all. Reduced motion skips the wait entirely.
   */
  const close = () => {
    if (closeTimer.current) return;
    if (prefersReducedMotion) {
      dialogRef.current?.close();
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      dialogRef.current?.close();
      onClose();
      // Cleared here rather than on the next open: setting it from the reopen
      // effect would be a synchronous setState in an effect body, which
      // cascades a render on every single open.
      setClosing(false);
    }, DIALOG_EXIT_MS);
  };

  const requestClose = () => {
    if (!inFlight.current) close();
  };

  const submit = async () => {
    if (inFlight.current || !canSubmitCreateList(state)) return;
    inFlight.current = true;
    dispatch({ type: 'submit' });
    try {
      const fields = { name: state.name.trim(), icon: state.icon, color: state.color };
      if (editing) await onSave(listId, fields);
      else await onCreate(fields.name, fields.icon, fields.color);
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
      className={`create-list-dialog${closing ? ' is-closing' : ''}`}
      aria-label={editing ? copy.editTitle : copy.title}
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
      <div className={`create-list-card${closing ? ' is-closing' : ''}`}>
        <div className="create-list-header">
          <h3>{editing ? copy.editTitle : copy.title}</h3>
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
            aria-invalid={state.error ? 'true' : undefined}
            aria-describedby={state.error ? nameErrorId : undefined}
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

        <div className="create-list-field">
          <span id="create-list-color-label">{copy.colorLabel}</span>
          <div
            className="create-list-color-picker"
            role="radiogroup"
            aria-labelledby="create-list-color-label"
          >
            {LIST_COLORS.map((colorId) => (
              <button
                key={colorId}
                type="button"
                role="radio"
                aria-checked={state.color === colorId}
                aria-label={copy.colors[colorId]}
                title={copy.colors[colorId]}
                className={`create-list-color-btn${state.color === colorId ? ' is-active' : ''}`}
                style={{ '--swatch': `var(--list-${colorId})` }}
                onClick={() => dispatch({ type: 'color', value: colorId })}
              >
                {state.color === colorId && <Check size={15} strokeWidth={3} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <p className="create-list-color-hint">{editing ? copy.colorHintEdit : copy.colorHint}</p>
        </div>

        {!editing && <p className="create-list-note">{copy.privacyNote}</p>}

        {state.error && (
          <p id={nameErrorId} className="create-list-error" role="alert">
            {editing ? copy.editError : copy.error}
          </p>
        )}

        <div className="create-list-actions">
          <Button variant="outline" onClick={requestClose}>
            {copy.cancel}
          </Button>
          <Button onClick={submit} disabled={!canSubmitCreateList(state)}>
            {editing
              ? (state.busy ? copy.saving : copy.save)
              : (state.busy ? copy.creating : copy.create)}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
