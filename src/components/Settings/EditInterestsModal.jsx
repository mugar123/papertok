import { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import { CATEGORIES } from '../../data/categories';
import './EditInterestsModal.css';

export default function EditInterestsModal({ isOpen, onClose }) {
  const { userPreferences, updatePreferences } = useAuth();
  const { isEnglish } = useLanguage();
  const [selected, setSelected] = useState(new Set());
  const [isClosing, setIsClosing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Initialize selection when modal opens
  useEffect(() => {
    if (isOpen && userPreferences) {
      setTimeout(() => {
        setSelected(new Set(userPreferences));
        setIsClosing(false);
        setFormError('');
      }, 0);
    }
  }, [isOpen, userPreferences]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300); // match animation duration
  };

  // The overlay stays mounted through the 300ms close animation above, so the
  // trap must too — it releases (and returns focus) only once the component
  // is about to render null. Escape now closes through the same handleClose
  // as the button, instead of skipping the animation.
  const dialogRef = useDialogFocus(isOpen || isClosing, handleClose);

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
      // file already uses elsewhere (see the init effect and handleClose).
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
      handleClose();
    } catch (error) {
      console.error('Error saving preferences:', error);
      setFormError(isEnglish
        ? 'We could not save your changes. Try again.'
        : 'No se pudieron guardar los cambios. Inténtalo de nuevo.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen && !isClosing) return null;

  return (
    <div className={`eim-overlay ${isClosing ? 'eim-overlay--closing' : ''}`}>
      <div
        ref={dialogRef}
        className="eim-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eim-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eim-header">
          <div className="eim-header-text">
            <h2 id="eim-title">{isEnglish ? 'Configure your algorithm' : 'Configura tu algoritmo'}</h2>
            <p>{isEnglish
              ? 'Select the research areas you want to see in your feed'
              : 'Selecciona las áreas de investigación que quieres ver en tu feed'}</p>
          </div>
          <button
            className="eim-close-btn"
            onClick={handleClose}
            data-dialog-initial-focus
            aria-label={isEnglish ? 'Close' : 'Cerrar'}
          >
            <X size={20} />
          </button>
        </div>

        <div className="eim-body">
          {Object.entries(CATEGORIES).map(([areaKey, area]) => {
            const subKeys = Object.keys(area.subcategories);
            const allSelected = subKeys.every(k => selected.has(k));
            
            return (
              <div key={areaKey} className="eim-area">
                <div className="eim-area-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <div className="eim-area-icon">
                      <area.icon size={24} />
                    </div>
                    <h3 className="eim-area-title">{isEnglish ? area.labelEn : area.label}</h3>
                  </div>
                  <button 
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
                      <button
                        key={subKey}
                        className={`eim-pill ${isSelected ? 'eim-pill--selected' : ''}`}
                        onClick={() => toggleSubcategory(subKey)}
                      >
                        <div className="eim-pill-content">
                          {isSelected && <Check size={14} strokeWidth={3} className="eim-pill-check" />}
                          <span>{isEnglish ? sub.labelEn || sub.label : sub.label}</span>
                        </div>
                      </button>
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
            className="eim-save-btn"
            onClick={handleSave}
            disabled={isSaving}
          >
            {/* The spinner is decorative; the label stays put beside it so the
                button keeps an accessible name — "Saving..." rather than
                nothing — for the whole time it is busy. */}
            {isSaving && <div className="eim-spinner" aria-hidden="true" />}
            {isSaving ? (isEnglish ? 'Saving...' : 'Guardando...') : (isEnglish ? 'Save changes' : 'Guardar cambios')}
          </button>
        </div>
      </div>
    </div>
  );
}
