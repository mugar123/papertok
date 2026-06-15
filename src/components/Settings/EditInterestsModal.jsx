import { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { CATEGORIES } from '../../data/categories';
import './EditInterestsModal.css';

export default function EditInterestsModal({ isOpen, onClose }) {
  const { userPreferences, updatePreferences } = useAuth();
  const [selected, setSelected] = useState(new Set());
  const [isClosing, setIsClosing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Initialize selection when modal opens
  useEffect(() => {
    if (isOpen && userPreferences) {
      setSelected(new Set(userPreferences));
      setIsClosing(false);
    }
  }, [isOpen, userPreferences]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300); // match animation duration
  };

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
    if (selected.size === 0) return;
    setIsSaving(true);
    try {
      await updatePreferences(Array.from(selected));
      handleClose();
    } catch (error) {
      console.error('Error saving preferences:', error);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen && !isClosing) return null;

  return (
    <div className={`eim-overlay ${isClosing ? 'eim-overlay--closing' : ''}`}>
      <div className="eim-modal" onClick={(e) => e.stopPropagation()}>
        <div className="eim-header">
          <div className="eim-header-text">
            <h2>Configura tu algoritmo</h2>
            <p>Selecciona las áreas de investigación que quieres ver en tu feed</p>
          </div>
          <button className="eim-close-btn" onClick={handleClose}>
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
                    <h3 className="eim-area-title">{area.label}</h3>
                  </div>
                  <button 
                    className="eim-area-toggle-btn" 
                    onClick={() => toggleArea(areaKey)}
                  >
                    {allSelected ? 'Deseleccionar todo' : 'Seleccionar todo'}
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
                          <span>{sub.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="eim-footer">
          <span className="eim-selected-count">
            {selected.size} interese{selected.size !== 1 ? 's' : ''} seleccionado{selected.size !== 1 ? 's' : ''}
          </span>
          <button 
            className="eim-save-btn" 
            onClick={handleSave} 
            disabled={selected.size === 0 || isSaving}
          >
            {isSaving ? <div className="eim-spinner" /> : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}
