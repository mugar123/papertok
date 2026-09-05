import { useRef, useState } from 'react';
import { PROFILE_VISIBILITY, saveProfileVisibility } from '../../services/userProfileService.js';
import { Button } from '../ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.jsx';
import VisibilityChoice from './VisibilityChoice.jsx';
import './VisibilityPrompt.css';

/**
 * The one-time choice for accounts whose profile predates F8.
 *
 * Until they answer, their profile keeps the visibility it already had —
 * public — because changing somebody's visibility without asking is the exact
 * thing this phase exists to avoid. So this is a prompt, not a wall: it can be
 * dismissed, and it comes back next time the profile is opened.
 *
 * It renders where the profile document has already been read (the profile page
 * and the editor), so asking the question costs no extra read. An account that
 * never opens its profile is never asked, and stays exactly as it is.
 *
 * ProfilePage mounts it only while the question is open, so the dialog opens
 * on mount and owns its `open` flag. Every way out flips it — a saved answer,
 * "Decide later", the X, Escape, the scrim — Base UI plays the leave, and only
 * then `onOpenChangeComplete(false)` hands the outcome to the parent: the
 * saved choice through `onResolved`, anything else through `onDismiss`.
 */
export default function VisibilityPrompt({ isEnglish, onResolved, onDismiss }) {
  const [open, setOpen] = useState(true);
  const [choice, setChoice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const savedChoice = useRef(null);
  const laterButton = useRef(null);

  const copy = isEnglish ? {
    eyebrow: 'One-time question',
    title: 'Your profile is public right now',
    intro: 'PaperTok now lets a profile be private. Nothing has changed about yours — it is public, exactly as it was. Choose what you want it to be.',
    confirm: 'Save my choice',
    saving: 'Saving...',
    later: 'Decide later',
    failed: 'That did not go through. Try again.',
    close: 'Close',
  } : {
    eyebrow: 'Pregunta única',
    title: 'Ahora mismo tu perfil es público',
    intro: 'PaperTok ya permite tener el perfil privado. Con el tuyo no ha cambiado nada: sigue público, exactamente como estaba. Elige qué quieres que sea.',
    confirm: 'Guardar mi elección',
    saving: 'Guardando...',
    later: 'Decidir más tarde',
    failed: 'No se pudo completar. Inténtalo de nuevo.',
    close: 'Cerrar',
  };

  const submit = async () => {
    if (!choice || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await saveProfileVisibility(choice);
      savedChoice.current = choice;
      setOpen(false);
    } catch (error) {
      console.error('Error saving the visibility choice:', error);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const settle = (isOpen) => {
    if (isOpen) return;
    if (savedChoice.current) onResolved(savedChoice.current);
    else onDismiss();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen} onOpenChangeComplete={settle} modal>
      <DialogContent
        className="visibility-prompt"
        overlayClassName="visibility-prompt-backdrop"
        closeLabel={copy.close}
        // "Decide later" takes the focus on arrival, as it always has: the
        // safe answer is the one under the finger, never a choice.
        initialFocus={laterButton}
      >
        <header className="visibility-prompt-header">
          <p className="visibility-prompt-eyebrow">{copy.eyebrow}</p>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="visibility-prompt-intro">{copy.intro}</DialogDescription>
        </header>

        <VisibilityChoice
          value={choice}
          onChange={setChoice}
          isEnglish={isEnglish}
          idPrefix="visibility-prompt"
        />

        {failed && <p className="visibility-prompt-error" role="alert">{copy.failed}</p>}

        <div className="visibility-prompt-actions">
          <Button
            ref={laterButton}
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            {copy.later}
          </Button>
          <Button
            variant="default"
            onClick={submit}
            disabled={!choice || saving}
          >
            {saving ? copy.saving : copy.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { PROFILE_VISIBILITY };
