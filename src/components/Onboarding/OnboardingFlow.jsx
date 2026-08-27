import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { CATEGORIES } from '../../data/categories';
import './OnboardingFlow.css';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';

const AREA_ENTRIES = Object.entries(CATEGORIES);

/** Cuántas subcategorías tiene cada área, contadas una vez del dato real. */
const AREA_SIZES = Object.fromEntries(
  AREA_ENTRIES.map(([key, area]) => [key, Object.keys(area.subcategories).length])
);

const TOTAL_SUBCATEGORIES = Object.values(AREA_SIZES).reduce((n, size) => n + size, 0);

/** Los tres tramos del rail, en las dos lenguas. */
const STEPS = [
  { n: '01', label: 'Áreas', labelEn: 'Areas' },
  { n: '02', label: 'Categorías', labelEn: 'Categories' },
  { n: '03', label: 'Tu feed', labelEn: 'Your feed' },
];

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

  /* ── Cifras derivadas ──
     El pie de página cuenta en voz alta lo que hay elegido, que es lo que el
     diseño anterior no decía en ninguna parte: el botón se apagaba y ya. */
  const availableSubcategories = useMemo(
    () => Array.from(selectedAreas).reduce((n, key) => n + (AREA_SIZES[key] ?? 0), 0),
    [selectedAreas]
  );

  const areasWithPicks = useMemo(
    () => Array.from(selectedAreas).filter((key) =>
      Object.keys(CATEGORIES[key].subcategories).some((id) => selectedSubcategories.has(id))
    ).length,
    [selectedAreas, selectedSubcategories]
  );

  /* El recibo del paso 3: por área, cuántas entran, de cuántas, y una muestra. */
  const receipt = useMemo(() => (
    Array.from(selectedAreas).map((key) => {
      const area = CATEGORIES[key];
      const ids = Object.keys(area.subcategories);
      const chosen = ids.filter((id) => selectedSubcategories.has(id));
      if (chosen.length === 0) return null;
      const sample = chosen.slice(0, 3).map((id) => {
        const cat = area.subcategories[id];
        return isEnglish ? (cat.labelEn || cat.label) : cat.label;
      });
      return { key, area, count: chosen.length, total: ids.length, sample, rest: chosen.length - sample.length };
    }).filter(Boolean)
  ), [selectedAreas, selectedSubcategories, isEnglish]);

  const plural = (n, one, many) => (n === 1 ? one : many);

  const tally = step === 1
    ? (selectedAreas.size > 0
      ? `${selectedAreas.size} ${plural(selectedAreas.size, isEnglish ? 'area' : 'área', isEnglish ? 'areas' : 'áreas')} · ${availableSubcategories} ${plural(availableSubcategories, isEnglish ? 'category' : 'categoría', isEnglish ? 'categories' : 'categorías')}`
      : (isEnglish ? 'No areas selected' : 'Ninguna área marcada'))
    : (selectedSubcategories.size > 0
      ? `${selectedSubcategories.size} ${plural(selectedSubcategories.size, isEnglish ? 'category' : 'categoría', isEnglish ? 'categories' : 'categorías')} · ${areasWithPicks} ${isEnglish ? 'of' : 'de'} ${selectedAreas.size}`
      : (isEnglish ? 'No categories selected' : 'Ninguna categoría marcada'));

  const hint = step === 1
    ? (selectedAreas.size > 0
      ? (isEnglish
        ? 'Next you pick which of those categories make it into your feed.'
        : 'En el paso siguiente eliges cuáles de esas categorías entran en tu feed.')
      : (isEnglish ? 'Select at least one area to continue.' : 'Marca al menos un área para continuar.'))
    : (selectedSubcategories.size > 0
      ? (isEnglish ? 'That is enough to build your feed.' : 'Con esto ya podemos armar tu feed.')
      : (isEnglish ? 'Select at least one category to continue.' : 'Marca al menos una categoría para continuar.'));

  return (
    <div className="onboarding">
      {/* El papel cuadriculado solo en la entrada, para enlazar con la pantalla
          de acceso; detrás de las categorías sería ruido. */}
      {step === 1 && <div className="onboarding-paper" aria-hidden="true" />}

      <header className="onboarding-bar">
        <span className="onboarding-brand">
          <span className="onboarding-mark">P</span>
          <span className="onboarding-wordmark">Paper<span>Tok</span></span>
        </span>
        <span className="onboarding-stepcount">
          {isEnglish ? 'Step' : 'Paso'} <b>{STEPS[step - 1].n}</b> / 03
        </span>
      </header>

      <div className="onboarding-body">
        <nav className="onboarding-rail" aria-label={isEnglish ? 'Progress' : 'Progreso'}>
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className={`onboarding-rail-seg ${i + 1 === step ? 'is-active' : ''} ${i + 1 < step ? 'is-done' : ''}`}
              aria-current={i + 1 === step ? 'step' : undefined}
            >
              <span className="onboarding-rail-n">{s.n}</span>
              <span className="onboarding-rail-t">{isEnglish ? s.labelEn : s.label}</span>
            </div>
          ))}
        </nav>

        {/* ── Paso 1: las áreas ── */}
        {step === 1 && (
          <div className="onboarding-step" key="step1">
            <div className="onboarding-head">
              <div className="onboarding-head-copy">
                <span className="onboarding-eyebrow">{isEnglish ? 'Let’s begin' : 'Empecemos'}</span>
                <h1 className="onboarding-title">
                  {isEnglish ? 'Choose your areas of interest' : 'Elige tus áreas de interés'}
                </h1>
                <p className="onboarding-lede">
                  {isEnglish
                    ? 'This is what your feed is built from. Mark the ones you care about — next you narrow down the specific categories, and you can change it any time from Settings.'
                    : 'Con esto armamos tu feed. Marca las que te interesen — en el paso siguiente afinas las categorías concretas, y puedes cambiarlo cuando quieras desde Ajustes.'}
                </p>
              </div>
              <div className="onboarding-meter">
                <span className="onboarding-meter-n">
                  {selectedAreas.size}<i>/{AREA_ENTRIES.length}</i>
                </span>
                <span className="onboarding-meter-l">{isEnglish ? 'Areas selected' : 'Áreas marcadas'}</span>
              </div>
            </div>

            <div className="onboarding-areas">
              {AREA_ENTRIES.map(([key, area]) => {
                const isSelected = selectedAreas.has(key);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`area-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => toggleArea(key)}
                    aria-pressed={isSelected}
                    style={{ '--area-accent': area.gradient }}
                  >
                    <span className="area-card-top">
                      <span className="area-card-icon"><area.icon size={20} strokeWidth={1.75} /></span>
                      <span className="area-card-count">
                        {AREA_SIZES[key]} {isEnglish ? 'cat.' : 'cat.'}
                      </span>
                      <span className="area-card-box"><Check size={11} strokeWidth={3.5} /></span>
                    </span>
                    <span className="area-card-name">
                      <span>{isEnglish ? area.labelEn : area.label}</span>
                    </span>
                    <span className="area-card-desc">
                      {isEnglish ? area.descriptionEn : area.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Paso 2: las categorías ── */}
        {step === 2 && (
          <div className="onboarding-step" key="step2">
            <div className="onboarding-head">
              <div className="onboarding-head-copy">
                <span className="onboarding-eyebrow">
                  {selectedAreas.size} {plural(selectedAreas.size, isEnglish ? 'area' : 'área', isEnglish ? 'areas' : 'áreas')}
                  {' · '}
                  {availableSubcategories} {isEnglish ? 'categories available' : 'categorías disponibles'}
                </span>
                <h1 className="onboarding-title">
                  {isEnglish ? 'Refine your interests' : 'Afina tus intereses'}
                </h1>
                <p className="onboarding-lede">
                  {isEnglish
                    ? 'Only the categories you mark here reach your feed. The fewer you pick, the tighter it gets — and you can always add more later.'
                    : 'Solo entrarán en tu feed las categorías que marques aquí. Cuantas menos elijas, más ajustado será — y siempre puedes ampliar después.'}
                </p>
              </div>
              <div className="onboarding-meter">
                <span className="onboarding-meter-n">
                  {selectedSubcategories.size}<i>/{availableSubcategories}</i>
                </span>
                <span className="onboarding-meter-l">{isEnglish ? 'Categories selected' : 'Categorías marcadas'}</span>
              </div>
            </div>

            <div className="onboarding-subcategories">
              {Array.from(selectedAreas).map((areaKey) => {
                const area = CATEGORIES[areaKey];
                const subcatIds = Object.keys(area.subcategories);
                const chosen = subcatIds.filter((id) => selectedSubcategories.has(id)).length;
                const allSelected = chosen === subcatIds.length;
                return (
                  <section key={areaKey} className="subcat-section" style={{ '--area-accent': area.gradient }}>
                    <div className="subcat-section-header">
                      <span className="subcat-section-icon"><area.icon size={18} strokeWidth={1.75} /></span>
                      <h2 className="subcat-section-title">{isEnglish ? area.labelEn : area.label}</h2>
                      <span className="subcat-section-count">{chosen} / {subcatIds.length}</span>
                      <button
                        type="button"
                        className={`subcat-select-all ${allSelected ? 'is-active' : ''}`}
                        onClick={() => selectAllInArea(areaKey)}
                      >
                        {allSelected
                          ? (isEnglish ? 'Deselect all' : 'Quitar todo')
                          : (isEnglish ? 'Select all' : 'Seleccionar todo')}
                      </button>
                    </div>
                    <div className="subcat-chips">
                      {Object.entries(area.subcategories).map(([catId, cat]) => {
                        const isSelected = selectedSubcategories.has(catId);
                        return (
                          <button
                            key={catId}
                            type="button"
                            className={`subcat-chip ${isSelected ? 'is-selected' : ''}`}
                            onClick={() => toggleSubcategory(catId)}
                            aria-pressed={isSelected}
                          >
                            <span className="subcat-chip-dot" />
                            {isEnglish ? cat.labelEn || cat.label : cat.label}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Paso 3: el recibo ── */}
        {step === 3 && (
          <div className="onboarding-step onboarding-step--confirm" key="step3">
            <div className="onboarding-confirm-copy">
              <span className="onboarding-eyebrow">{isEnglish ? 'Done' : 'Hecho'}</span>
              <h1 className="onboarding-title onboarding-title--big">
                {isEnglish ? <>Your feed is <span>ready</span></> : <>Tu feed está <span>listo</span></>}
              </h1>
              <p className="onboarding-lede">
                {isEnglish
                  ? `You will see papers from the ${selectedSubcategories.size} categories you picked, ordered by what works for you. You can adjust the selection any time from Settings.`
                  : `Vas a ver papers de las ${selectedSubcategories.size} categorías que marcaste, ordenados por lo que vaya funcionando contigo. Puedes ajustar la selección cuando quieras desde Ajustes.`}
              </p>
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="onboarding-btn onboarding-btn--ink onboarding-btn--lg"
                  onClick={handleFinish}
                  disabled={saving}
                >
                  {saving ? (
                    <span className="onboarding-spinner" />
                  ) : (
                    <>
                      {isEnglish ? 'Start exploring' : 'Empezar a explorar'}
                      <ArrowRight size={16} strokeWidth={2.25} />
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="onboarding-btn onboarding-btn--ghost"
                  onClick={handleBack}
                  disabled={saving}
                >
                  {isEnglish ? 'Adjust selection' : 'Ajustar selección'}
                </button>
              </div>
            </div>

            <div className="onboarding-confirm-receipt">
              <div className="onboarding-receipt">
                <div className="onboarding-receipt-head">
                  <span>{isEnglish ? 'Area' : 'Área'}</span>
                  <span>{isEnglish ? 'Categories' : 'Categorías'}</span>
                </div>
                {receipt.map(({ key, area, count, total, sample, rest }) => (
                  <div key={key} className="onboarding-receipt-row" style={{ '--area-accent': area.gradient }}>
                    <span className="onboarding-receipt-icon"><area.icon size={19} strokeWidth={1.75} /></span>
                    <div className="onboarding-receipt-main">
                      <div className="onboarding-receipt-name">{isEnglish ? area.labelEn : area.label}</div>
                      <div className="onboarding-receipt-sample">
                        {sample.join(' · ')}
                        {rest > 0 && ` · +${rest} ${isEnglish ? 'more' : 'más'}`}
                      </div>
                    </div>
                    <div className="onboarding-receipt-count">
                      {count}<small>{isEnglish ? `of ${total}` : `de ${total}`}</small>
                    </div>
                  </div>
                ))}
                <div className="onboarding-receipt-total">
                  <span>{isEnglish ? 'Total' : 'Total'}</span>
                  <span className="onboarding-receipt-total-n">
                    {selectedSubcategories.size}<i> / {availableSubcategories || TOTAL_SUBCATEGORIES}</i>
                  </span>
                </div>
              </div>
              <span className="onboarding-receipt-note">
                {isEnglish ? 'Saved to your profile' : 'Guardado en tu perfil'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Pie: el recuento vive aquí, y el botón por fin se lee ── */}
      {step < 3 && (
        <footer className="onboarding-foot">
          <div className="onboarding-foot-inner">
            <div className="onboarding-tally">
              <span className={`onboarding-tally-n ${canProceed ? 'is-on' : ''}`}>{tally}</span>
              <span className="onboarding-tally-hint">{hint}</span>
            </div>
            {step > 1 && (
              <button type="button" className="onboarding-btn onboarding-btn--ghost" onClick={handleBack}>
                <ArrowLeft size={15} strokeWidth={2.25} />
                {isEnglish ? 'Back' : 'Atrás'}
              </button>
            )}
            <button
              type="button"
              className="onboarding-btn onboarding-btn--ink"
              onClick={handleNext}
              disabled={!canProceed}
            >
              {isEnglish ? 'Next' : 'Siguiente'}
              <ArrowRight size={15} strokeWidth={2.25} />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
