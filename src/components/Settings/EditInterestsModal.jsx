import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { CATEGORIES } from '../../data/categories';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.jsx';
import { Toggle } from '../ui/toggle.jsx';
import './EditInterestsModal.css';

/**
 * SettingsPage keeps this mounted and drives it through `isOpen`, so the
 * Dialog is controlled from outside: the X, Escape and the scrim report
 * `onOpenChange(false)`, which is the parent's `onClose`, and Base UI plays
 * the leave before the popup goes. The primitive also owns what this
 * overlay never had — a dialog role, `aria-modal`, the focus trap.
 */
export default function EditInterestsModal({ isOpen, onClose }) {
  const { userPreferences, updatePreferences } = useAuth();
  const { isEnglish } = useLanguage();
  const [selected, setSelected] = useState(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Initialize selection when modal opens
  useEffect(() => {
    if (isOpen && userPreferences) {
      const timeoutId = setTimeout(() => {
        setSelected(new Set(userPreferences));
        setFormError('');
      }, 0);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [isOpen, userPreferences]);

  const toggleSubcategory = (subKey) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(subKey)) {
        next.delete(subKey);
      } else {
        next.add(subKey);
      }
      return next;
    });
  };

  const toggleArea = (areaKey) => {
    const subKeys = Object.keys(CATEGORIES[areaKey].subcategories);
    const allSelected = subKeys.every(k => selected.has(k));
    
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        subKeys.forEach(k => next.delete(k));
      } else {
        subKeys.forEach(k => next.add(k));
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (selected.size === 0) {
      // A clear immediately followed by the same-tick set is not enough:
      // React 18+ batches both calls from one click into a single commit, and
      // when the resulting text matches what was already committed (a repeat
      // click with nothing selected), react-dom's own prop diff skips the DOM
      // write ('next === last' short-circuits before touching textContent) —
      // confirmed by reading react-dom-client's updateProperties and by a
      // jsdom repro with a MutationObserver: same-tick clear+set produced no
      // mutation and no re-announcement on the second click.
      // The failure branch below does not have this problem only because the
      // `await` separates its clear from its set into two distinct commits —
      // the element actually unmounts (formError is '', falsy) and remounts
      // fresh, which is a real, always-observable mutation. `setTimeout(0)`
      // recreates that same separation here, on the same tick-deferral this
      // file already uses elsewhere (see the init effect).
      setFormError('');
      setTimeout(() => {
        setFormError(isEnglish
          ? 'Select at least one research area.'
          : 'Selecciona al menos un área de investigación.');
      }, 0);
      return;
    }
    setFormError('');
    setIsSaving(true);
    try {
      await updatePreferences(Array.from(selected));
      onClose();
    } catch (error) {
      console.error('Error saving preferences:', error);
      setFormError(isEnglish
        ? 'We could not save your changes. Try again.'
        : 'No se pudieron guardar los cambios. Inténtalo de nuevo.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }} modal>
      <DialogContent
        className="eim-modal"
        overlayClassName="eim-overlay"
        closeLabel={isEnglish ? 'Close' : 'Cerrar'}
      >
        <div className="eim-header">
          <div className="eim-header-text">
            <DialogTitle>{isEnglish ? 'Configure your algorithm' : 'Configura tu algoritmo'}</DialogTitle>
            <DialogDescription>{isEnglish
              ? 'Select the research areas you want to see in your feed'
              : 'Selecciona las áreas de investigación que quieres ver en tu feed'}</DialogDescription>
          </div>
        </div>

        <div className="eim-body">
          {Object.entries(CATEGORIES).map(([areaKey, area]) => {
            const subKeys = Object.keys(area.subcategories);
            const allSelected = subKeys.every(k => selected.has(k));
            
            return (
              <div key={areaKey} className="eim-area">
                <div className="eim-area-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <div className="eim-area-icon" aria-hidden="true">
                      <area.icon size={24} />
                    </div>
                    <h3 className="eim-area-title">{isEnglish ? area.labelEn : area.label}</h3>
                  </div>
                  <button
                    type="button"
                    className="eim-area-toggle-btn"
                    onClick={() => toggleArea(areaKey)}
                  >
                    {allSelected
                      ? (isEnglish ? 'Deselect all' : 'Deseleccionar todo')
                      : (isEnglish ? 'Select all' : 'Seleccionar todo')}
                  </button>
                </div>
                <div className="eim-subcats">
                  {Object.entries(area.subcategories).map(([subKey, sub]) => {
                    const isSelected = selected.has(subKey);
                    return (
                      // The shared Toggle is a native button that writes
                      // `aria-pressed` and `data-pressed`; the pill's own CSS
                      // styles the pressed state off that attribute.
                      <Toggle
                        key={subKey}
                        variant="outline"
                        className="eim-pill"
                        pressed={isSelected}
                        onPressedChange={() => toggleSubcategory(subKey)}
                      >
                        <div className="eim-pill-content">
                          {isSelected && <Check size={14} strokeWidth={3} className="eim-pill-check" aria-hidden="true" />}
                          <span>{isEnglish ? sub.labelEn || sub.label : sub.label}</span>
                        </div>
                      </Toggle>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {formError && (
          <p className="eim-form-error" role="alert">{formError}</p>
        )}

        <div className="eim-footer">
          <span className="eim-selected-count">
            {isEnglish
              ? `${selected.size} selected ${selected.size === 1 ? 'interest' : 'interests'}`
              : `${selected.size} interese${selected.size !== 1 ? 's' : ''} seleccionado${selected.size !== 1 ? 's' : ''}`}
          </span>
          <button
            type="button"
            className="eim-save-btn"
            onClick={handleSave}
            disabled={isSaving}
            aria-busy={isSaving ? 'true' : undefined}
          >
            {/* The spinner is decorative; the label stays put beside it so the
                button keeps an accessible name — "Saving..." rather than
                nothing — for the whole time it is busy. */}
            {isSaving && <div className="eim-spinner" aria-hidden="true" />}
            {isSaving ? (isEnglish ? 'Saving...' : 'Guardando...') : (isEnglish ? 'Save changes' : 'Guardar cambios')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
