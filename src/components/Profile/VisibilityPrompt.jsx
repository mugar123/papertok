import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { PROFILE_VISIBILITY, saveProfileVisibility } from '../../services/userProfileService.js';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
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
 */
export default function VisibilityPrompt({ isEnglish, onResolved, onDismiss }) {
  const prefersReducedMotion = useReducedMotion();
  const [choice, setChoice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // The prompt only exists in the tree while it is shown, so `open` is always
  // true here — the same contract AuthPrompt uses.
  const dialogRef = useDialogFocus(true, onDismiss);

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
      onResolved(choice);
    } catch (error) {
      console.error('Error saving the visibility choice:', error);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      className="visibility-prompt-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.1 : 0.18 }}
      onClick={onDismiss}
    >
      <motion.div
        ref={dialogRef}
        className="visibility-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="visibility-prompt-title"
        tabIndex={-1}
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
        transition={prefersReducedMotion
          ? { duration: 0.1 }
          : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        onClick={event => event.stopPropagation()}
      >
        <header className="visibility-prompt-header">
          <p className="visibility-prompt-eyebrow">{copy.eyebrow}</p>
          <h2 id="visibility-prompt-title">{copy.title}</h2>
          <p className="visibility-prompt-intro">{copy.intro}</p>
        </header>

        <VisibilityChoice
          value={choice}
          onChange={setChoice}
          isEnglish={isEnglish}
          idPrefix="visibility-prompt"
        />

        {failed && <p className="visibility-prompt-error">{copy.failed}</p>}

        <div className="visibility-prompt-actions">
          <button
            type="button"
            className="visibility-prompt-later"
            data-dialog-initial-focus
            onClick={onDismiss}
            disabled={saving}
          >
            {copy.later}
          </button>
          <button
            type="button"
            className="visibility-prompt-confirm"
            onClick={submit}
            disabled={!choice || saving}
          >
            {saving ? copy.saving : copy.confirm}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export { PROFILE_VISIBILITY };
