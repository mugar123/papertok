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
 * A Base UI Dialog (ui/dialog.jsx), and a nested one when it is opened from
 * inside the save modal: the primitive keeps the stack, so Escape and a press
 * outside reach only the topmost window and fold this one without touching
 * the modal underneath or its unsaved-changes guard. The Root stays mounted
 * while `open` is false — that is how the exit gets to play before the popup
 * leaves the document.
 */
import { useEffect, useId, useReducer, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { AVAILABLE_ICONS, getIcon } from '../../utils/icons.js';
import { Button } from '../ui/button.jsx';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.jsx';
import {
  canSubmitCreateList,
  createListFormReducer,
  CREATE_LIST_FORM_INITIAL,
} from '../../utils/createListFormModel.js';
import { LIST_COLORS, randomListColorId, resolveListColorId } from '../../utils/listColors.js';
import './CreateListDialog.css';

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
  // Ties the name field to its error message (aria-describedby).
  const nameErrorId = useId();
  const inputRef = useRef(null);
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

  useEffect(() => {
    if (!open) return;
    inFlight.current = false;
    dispatch({
      type: 'open',
      preset: editing
        ? { name: listName, icon: listIcon, color: listColor }
        : { color: randomListColorId() },
    });
  }, [open, editing, listName, listIcon, listColor]);

  const copy = isEnglish ? COPY.en : COPY.es;

  /**
   * Every close path lands here, so none of them can abandon a write midway.
   * The caller owns `open`; clearing it starts the exit, and Base UI keeps the
   * popup in the document until `createListOut` has played (or, under
   * `prefers-reduced-motion`, not at all) and then hands focus back to the
   * button that opened the window.
   */
  const requestClose = () => {
    if (!inFlight.current) onClose();
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
      onClose();
    } catch {
      inFlight.current = false;
      dispatch({ type: 'failed' });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) requestClose(); }}
    >
      <DialogContent
        className="create-list-card"
        overlayClassName="create-list-scrim"
        showClose={false}
        closeLabel={copy.close}
        // The name field, and not the first tabbable thing (the X): a keyboard
        // user opens this window to type a name.
        initialFocus={inputRef}
      >
        <div className="create-list-header">
          <DialogTitle render={<h3 />}>{editing ? copy.editTitle : copy.title}</DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={copy.close} />}
          >
            <X size={16} aria-hidden="true" />
          </DialogClose>
        </div>

        <div className="create-list-field">
          <Label className="create-list-field-label" htmlFor="create-list-name">{copy.nameLabel}</Label>
          <Input
            id="create-list-name"
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
        </div>

        {/* Two pickers, two radio groups: one choice among a few, arrow keys
            between them, and a real button behind each swatch. The item
            styles itself from `data-checked`. */}
        <div className="create-list-field">
          <span id="create-list-icon-label" className="create-list-field-label">{copy.iconLabel}</span>
          <RadioGroup
            className="create-list-icon-picker"
            aria-labelledby="create-list-icon-label"
            value={state.icon}
            onValueChange={(value) => dispatch({ type: 'icon', value })}
          >
            {AVAILABLE_ICONS.map((iconName) => {
              const Icon = getIcon(iconName);
              return (
                <RadioGroupItem
                  key={iconName}
                  value={iconName}
                  aria-label={iconName}
                  nativeButton
                  render={<button type="button" className="create-list-icon-btn" />}
                >
                  <Icon size={22} strokeWidth={1.5} aria-hidden="true" />
                </RadioGroupItem>
              );
            })}
          </RadioGroup>
        </div>

        <div className="create-list-field">
          <span id="create-list-color-label" className="create-list-field-label">{copy.colorLabel}</span>
          <RadioGroup
            className="create-list-color-picker"
            aria-labelledby="create-list-color-label"
            value={state.color}
            onValueChange={(value) => dispatch({ type: 'color', value })}
          >
            {LIST_COLORS.map((colorId) => (
              <RadioGroupItem
                key={colorId}
                value={colorId}
                aria-label={copy.colors[colorId]}
                title={copy.colors[colorId]}
                nativeButton
                render={(
                  <button
                    type="button"
                    className="create-list-color-btn"
                    style={{ '--swatch': `var(--list-${colorId})` }}
                  />
                )}
              >
                {state.color === colorId && <Check size={15} strokeWidth={3} aria-hidden="true" />}
              </RadioGroupItem>
            ))}
          </RadioGroup>
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
      </DialogContent>
    </Dialog>
  );
}
