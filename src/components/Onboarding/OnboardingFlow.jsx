import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { CATEGORIES } from '../../data/categories';
import './OnboardingFlow.css';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';

export default function OnboardingFlow() {
  const [step, setStep] = useState(1);
  const [selectedAreas, setSelectedAreas] = useState(new Set());
  const [selectedSubcategories, setSelectedSubcategories] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const { completeOnboarding } = useAuth();
  const { isEnglish, language } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const returnTo = typeof location.state?.returnTo === 'string'
    && location.state.returnTo.startsWith('/')
    && !location.state.returnTo.startsWith('//')
    ? location.state.returnTo
    : '/';

  useEffect(() => {
    trackEvent('tutorial_begin', { language });
  }, [language, trackEvent]);

  const toggleArea = (areaKey) => {
    setSelectedAreas((prev) => {
      const next = new Set(prev);
      if (next.has(areaKey)) {
        next.delete(areaKey);
        // Also remove subcategories of this area
        const area = CATEGORIES[areaKey];
        setSelectedSubcategories((prevSubs) => {
          const nextSubs = new Set(prevSubs);
          Object.keys(area.subcategories).forEach((id) => nextSubs.delete(id));
          return nextSubs;
        });
      } else {
        next.add(areaKey);
      }
      return next;
    });
  };

  const toggleSubcategory = (catId) => {
    setSelectedSubcategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const selectAllInArea = (areaKey) => {
    const area = CATEGORIES[areaKey];
    const ids = Object.keys(area.subcategories);
    
    // Pure check using current state directly
    const allSelected = ids.every((id) => selectedSubcategories.has(id));

    // Batch subcategory state update to run once
    setSelectedSubcategories((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => {
        if (allSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  };

  const handleNext = () => {
    if (step === 1 && selectedAreas.size > 0) {
      setStep(2);
    } else if (step === 2 && selectedSubcategories.size > 0) {
      setStep(3);
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      await completeOnboarding(Array.from(selectedSubcategories));
      trackEvent('tutorial_complete', { language });
      markActivation();
      navigate(returnTo, { replace: true });
    } catch (err) {
      console.error('Error saving preferences:', err);
      setSaving(false);
    }
  };

  const canProceed =
    (step === 1 && selectedAreas.size > 0) ||
    (step === 2 && selectedSubcategories.size > 0) ||
    step === 3;

  return (
    <div className="onboarding">
      {/* Progress bar */}
      <div className="onboarding-progress">
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            className={`onboarding-progress-dot ${s === step ? 'active' : ''} ${s < step ? 'done' : ''}`}
          />
        ))}
      </div>

      {/* Step 1: Select areas */}
      {step === 1 && (
        <div className="onboarding-step" key="step1">
          <h1 className="onboarding-title">
            {isEnglish ? 'Choose your areas of interest' : 'Elige tus áreas de interés'}
          </h1>
          <p className="onboarding-subtitle">
            {isEnglish
              ? 'Select the scientific areas that interest you'
              : 'Selecciona las áreas científicas que te apasionan'}
          </p>
          <div className="onboarding-areas-grid">
            {Object.entries(CATEGORIES).map(([key, area], index) => (
              <button
                key={key}
                className={`area-card ${selectedAreas.has(key) ? 'area-card--selected' : ''}`}
                onClick={() => toggleArea(key)}
                style={{
                  '--area-gradient': area.gradient,
                  '--delay': `${index * 0.06}s`,
                }}
              >
                <span className="area-card-icon"><area.icon size={36} strokeWidth={1.5} /></span>
                <span className="area-card-label">{isEnglish ? area.labelEn : area.label}</span>
                <span className="area-card-desc">{isEnglish ? area.descriptionEn : area.description}</span>
                {selectedAreas.has(key) && (
                  <span className="area-card-check">✓</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Select subcategories */}
      {step === 2 && (
        <div className="onboarding-step" key="step2">
          <h1 className="onboarding-title">{isEnglish ? 'Refine your interests' : 'Afina tus intereses'}</h1>
          <p className="onboarding-subtitle">
            {isEnglish
              ? `Select specific subcategories — ${selectedSubcategories.size} selected`
              : `Selecciona las subcategorías específicas — ${selectedSubcategories.size} seleccionadas`}
          </p>
          <div className="onboarding-subcategories">
            {Array.from(selectedAreas).map((areaKey) => {
              const area = CATEGORIES[areaKey];
              const subcatIds = Object.keys(area.subcategories);
              const allSelected = subcatIds.every((id) => selectedSubcategories.has(id));
              return (
                <div key={areaKey} className="subcat-section">
                  <div className="subcat-section-header">
                    <span className="subcat-section-icon"><area.icon size={28} strokeWidth={1.5} /></span>
                    <h2 className="subcat-section-title">{isEnglish ? area.labelEn : area.label}</h2>
                    <button
                      className={`subcat-select-all ${allSelected ? 'subcat-select-all--active' : ''}`}
                      onClick={() => selectAllInArea(areaKey)}
                    >
                      {allSelected
                        ? (isEnglish ? 'Deselect all' : 'Deseleccionar todo')
                        : (isEnglish ? 'Select all' : 'Seleccionar todo')}
                    </button>
                  </div>
                  <div className="subcat-chips">
                    {Object.entries(area.subcategories).map(([catId, cat]) => (
                      <button
                        key={catId}
                        className={`subcat-chip ${selectedSubcategories.has(catId) ? 'subcat-chip--selected' : ''}`}
                        onClick={() => toggleSubcategory(catId)}
                        style={{ '--area-gradient': area.gradient }}
                      >
                        {isEnglish ? cat.labelEn || cat.label : cat.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 3: Confirmation */}
      {step === 3 && (
        <div className="onboarding-step onboarding-step--confirm" key="step3">
          <div className="confirm-check">
            <svg viewBox="0 0 52 52" className="confirm-check-svg">
              <circle cx="26" cy="26" r="25" fill="none" stroke="url(#confirmGrad)" strokeWidth="2" />
              <path fill="none" stroke="url(#confirmGrad)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" d="M14 27l8 8 16-16" className="confirm-check-path" />
              <defs>
                <linearGradient id="confirmGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#7c3aed" />
                  <stop offset="100%" stopColor="#06b6d4" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 className="onboarding-title">{isEnglish ? 'Your feed is ready!' : '¡Tu feed está listo!'}</h1>
          <p className="onboarding-subtitle">
            {isEnglish
              ? `We configured ${selectedSubcategories.size} subcategories for your personalized feed`
              : `Hemos configurado ${selectedSubcategories.size} subcategorías para tu feed personalizado`}
          </p>
          <div className="confirm-summary">
            {Array.from(selectedAreas).map((areaKey) => {
              const area = CATEGORIES[areaKey];
              const count = Object.keys(area.subcategories).filter((id) =>
                selectedSubcategories.has(id)
              ).length;
              if (count === 0) return null;
              return (
                <span key={areaKey} className="confirm-badge" style={{ '--area-gradient': area.gradient }}>
                  <area.icon size={16} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'text-bottom', marginRight: '4px' }} />
                  {isEnglish ? area.labelEn : area.label} ({count})
                </span>
              );
            })}
          </div>
          <button
            className="onboarding-finish-btn"
            onClick={handleFinish}
            disabled={saving}
          >
            {saving ? (
              <span className="onboarding-spinner" />
            ) : (
              (isEnglish ? 'Start exploring' : 'Empezar a explorar')
            )}
          </button>
        </div>
      )}

      {/* Navigation */}
      {step < 3 && (
        <div className="onboarding-nav">
          {step > 1 && (
            <button className="onboarding-nav-btn onboarding-nav-btn--back" onClick={handleBack}>
              {isEnglish ? '← Back' : '← Atrás'}
            </button>
          )}
          <button
            className="onboarding-nav-btn onboarding-nav-btn--next"
            onClick={handleNext}
            disabled={!canProceed}
          >
            {isEnglish ? 'Next →' : 'Siguiente →'}
          </button>
        </div>
      )}
    </div>
  );
}
