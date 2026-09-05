import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { CATEGORIES } from '../../data/categories';
import './OnboardingFlow.css';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import VisibilityChoice from '../Profile/VisibilityChoice.jsx';
import {
  HandleUnavailableError,
  PROFILE_VISIBILITY,
  USER_PROFILE_LIMITS,
  createUserProfile,
  readOwnUserProfile,
} from '../../services/userProfileService.js';
import { HANDLE_ERRORS, HANDLE_MAX_LENGTH, inspectHandle } from '../../utils/userHandle.js';
import { guestCategoriesForAreas, readGuestInterests } from '../../utils/guestInterests.js';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import { Toggle } from '../ui/toggle.jsx';

const AREA_ENTRIES = Object.entries(CATEGORIES);

/** Cuántas subcategorías tiene cada área, contadas una vez del dato real. */
const AREA_SIZES = Object.fromEntries(
  AREA_ENTRIES.map(([key, area]) => [key, Object.keys(area.subcategories).length])
);

const TOTAL_SUBCATEGORIES = Object.values(AREA_SIZES).reduce((n, size) => n + size, 0);

/** The four tramos of the rail, in both languages. */
const STEPS = [
  { n: '01', label: 'Áreas', labelEn: 'Areas' },
  { n: '02', label: 'Categorías', labelEn: 'Categories' },
  { n: '03', label: 'Tu feed', labelEn: 'Your feed' },
  { n: '04', label: 'Perfil', labelEn: 'Profile' },
];

const HANDLE_ERROR_COPY = {
  en: {
    [HANDLE_ERRORS.empty]: 'Choose a handle.',
    [HANDLE_ERRORS.tooShort]: 'A handle needs at least 3 characters.',
    [HANDLE_ERRORS.tooLong]: 'A handle can have at most 40 characters.',
    [HANDLE_ERRORS.charset]: 'Use lowercase letters, numbers and underscores only.',
    [HANDLE_ERRORS.numericOnly]: 'A handle needs at least one letter.',
    [HANDLE_ERRORS.reserved]: 'That handle is reserved.',
  },
  es: {
    [HANDLE_ERRORS.empty]: 'Elige un handle.',
    [HANDLE_ERRORS.tooShort]: 'Un handle necesita al menos 3 caracteres.',
    [HANDLE_ERRORS.tooLong]: 'Un handle puede tener como mucho 40 caracteres.',
    [HANDLE_ERRORS.charset]: 'Usa solo minúsculas, números y guiones bajos.',
    [HANDLE_ERRORS.numericOnly]: 'Un handle necesita al menos una letra.',
    [HANDLE_ERRORS.reserved]: 'Ese handle está reservado.',
  },
};

export default function OnboardingFlow() {
  // What this visitor said they were into before they had an account
  // (GuestInterestsPrompt). Read once: the answer is the starting point, not
  // a live source, and the areas step below can change everything about it.
  // With an answer, the flow opens on the receipt already filled in — every
  // category of every area they picked — rather than asking the same
  // question twice. AuthContext clears the answer once completeOnboarding
  // has written it to the profile.
  const [guestSeed] = useState(() => {
    const stored = readGuestInterests();
    return stored?.areas.length ? stored.areas : null;
  });
  const [stepState, setStep] = useState(guestSeed ? 3 : 1);
  const [selectedAreas, setSelectedAreas] = useState(() => new Set(guestSeed ?? []));
  const [selectedSubcategories, setSelectedSubcategories] = useState(() => new Set(guestCategoriesForAreas(guestSeed ?? [])));
  // Whether the receipt still shows the guest answer untouched. Once they
  // go back and adjust, it is their selection, and the copy says so.
  const [seedAdjusted, setSeedAdjusted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibilityDraft, setVisibilityDraft] = useState(null);
  const [handleDraft, setHandleDraft] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileError, setProfileError] = useState(null);
  const [existingProfile, setExistingProfile] = useState(false);
  // Set the moment createUserProfile succeeds. A retry after a failed
  // completeOnboarding must skip the create: the handle is already this
  // account's, and a second create hits its own reservation as "taken".
  const profileCreated = useRef(false);
  const { completeOnboarding, onboardingComplete, user } = useAuth();
  const { isEnglish, language } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const returnTo = typeof location.state?.returnTo === 'string'
    && location.state.returnTo.startsWith('/')
    && !location.state.returnTo.startsWith('//')
    ? location.state.returnTo
    : '/';

  const step = existingProfile && stepState > 3 ? 3 : stepState;
  const visibleSteps = existingProfile ? STEPS.slice(0, 3) : STEPS;
  const handleCheck = useMemo(() => inspectHandle(handleDraft), [handleDraft]);
  const handleError = handleCheck.valid
    ? null
    : HANDLE_ERROR_COPY[isEnglish ? 'en' : 'es'][handleCheck.code];
  const googleDisplayName = user?.displayName
    ? String(user.displayName).slice(0, USER_PROFILE_LIMITS.displayName)
    : '';
  const resolvedDisplayName = displayName.trim() || googleDisplayName;

  useEffect(() => {
    if (onboardingComplete) navigate(returnTo, { replace: true });
  }, [onboardingComplete, navigate, returnTo]);

  useEffect(() => {
    let active = true;
    readOwnUserProfile()
      .then(profile => { if (active) setExistingProfile(Boolean(profile)); })
      .catch(() => { if (active) setExistingProfile(false); });
    return () => { active = false; };
  }, []);

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
    } else if (step === 3 && !existingProfile) {
      setStep(4);
    }
  };

  const handleBack = () => {
    if (step === 3 && guestSeed) setSeedAdjusted(true);
    if (step > 1) setStep(step - 1);
  };

  const handleFinish = async () => {
    setSaving(true);
    setProfileError(null);
    try {
      if (!existingProfile && !profileCreated.current && visibilityDraft === PROFILE_VISIBILITY.public) {
        if (!handleCheck.valid || !resolvedDisplayName) {
          setSaving(false);
          return;
        }
        await createUserProfile({
          handle: handleCheck.handle,
          displayName: resolvedDisplayName,
          bio: '',
          allowContact: false,
          photo: '',
          visibility: PROFILE_VISIBILITY.public,
        });
        profileCreated.current = true;
      }
      await completeOnboarding(Array.from(selectedSubcategories));
      trackEvent('tutorial_complete', { language });
      markActivation();
      navigate(returnTo, { replace: true });
    } catch (err) {
      if (err instanceof HandleUnavailableError) {
        setProfileError(isEnglish
          ? 'That handle is already taken. Try another.'
          : 'Ese handle ya está cogido. Prueba otro.');
      } else {
        console.error('Error saving preferences:', err);
        setProfileError(isEnglish
          ? 'Could not save. Try again.'
          : 'No se pudo guardar. Inténtalo de nuevo.');
      }
      setSaving(false);
    }
  };

  const canProceed =
    (step === 1 && selectedAreas.size > 0) ||
    (step === 2 && selectedSubcategories.size > 0) ||
    step === 3 ||
    (step === 4 && (
      visibilityDraft === PROFILE_VISIBILITY.private
      || (visibilityDraft === PROFILE_VISIBILITY.public
        && handleCheck.valid
        && resolvedDisplayName)
    ));

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
          {isEnglish ? 'Step' : 'Paso'} <b>{visibleSteps[step - 1].n}</b> / {String(visibleSteps.length).padStart(2, '0')}
        </span>
      </header>

      <div className="onboarding-body">
        <nav className="onboarding-rail" aria-label={isEnglish ? 'Progress' : 'Progreso'}>
          {visibleSteps.map((s, i) => (
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
                  // The shared Toggle: a native button that writes `aria-pressed`
                  // and `data-pressed`; the card's CSS reads the attribute.
                  <Toggle
                    key={key}
                    variant="outline"
                    className="area-card"
                    pressed={isSelected}
                    onPressedChange={() => toggleArea(key)}
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
                  </Toggle>
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
                          <Toggle
                            key={catId}
                            variant="outline"
                            className="subcat-chip"
                            pressed={isSelected}
                            onPressedChange={() => toggleSubcategory(catId)}
                          >
                            <span className="subcat-chip-dot" />
                            {isEnglish ? cat.labelEn || cat.label : cat.label}
                          </Toggle>
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
              <span className="onboarding-eyebrow">
                {guestSeed && !seedAdjusted
                  ? (isEnglish ? 'What you picked as a guest' : 'Lo que elegiste como invitado')
                  : (isEnglish ? 'Done' : 'Hecho')}
              </span>
              <h1 className="onboarding-title onboarding-title--big">
                {isEnglish ? <>Your feed is <span>ready</span></> : <>Tu feed está <span>listo</span></>}
              </h1>
              <p className="onboarding-lede">
                {guestSeed && !seedAdjusted
                  ? (isEnglish
                    ? `We kept the ${selectedAreas.size} ${selectedAreas.size === 1 ? 'area' : 'areas'} you picked before signing in — every one of its ${selectedSubcategories.size} categories. Narrow it down now, or any time from Settings.`
                    : `Guardamos ${selectedAreas.size === 1 ? 'el área que marcaste' : `las ${selectedAreas.size} áreas que marcaste`} antes de entrar, con sus ${selectedSubcategories.size} categorías. Afínalo ahora, o cuando quieras desde Ajustes.`)
                  : (isEnglish
                    ? `You will see papers from the ${selectedSubcategories.size} categories you picked, ordered by what works for you. You can adjust the selection any time from Settings.`
                    : `Vas a ver papers de las ${selectedSubcategories.size} categorías que marcaste, ordenados por lo que vaya funcionando contigo. Puedes ajustar la selección cuando quieras desde Ajustes.`)}
              </p>
              <div className="onboarding-actions">
                {existingProfile ? (
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
                ) : (
                  <button
                    type="button"
                    className="onboarding-btn onboarding-btn--ink onboarding-btn--lg"
                    onClick={handleNext}
                    disabled={saving}
                  >
                    {isEnglish ? 'Next: your profile' : 'Siguiente: tu perfil'}
                    <ArrowRight size={16} strokeWidth={2.25} />
                  </button>
                )}
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

        {step === 4 && (
          <div className="onboarding-step onboarding-step--profile" key="step4">
            <div className="onboarding-head">
              <div className="onboarding-head-copy">
                <span className="onboarding-eyebrow">{isEnglish ? 'One last thing' : 'Una cosa más'}</span>
                <h1 className="onboarding-title">
                  {isEnglish ? 'Do you want a public profile?' : '¿Quieres un perfil público?'}
                </h1>
                <p className="onboarding-lede">
                  {isEnglish
                    ? 'If you do, pick a handle. That is the name other people will see and the address of your page. You can stay private and skip this — Settings can create it later.'
                    : 'Si sí, elige un handle. Es el nombre que verán los demás y la dirección de tu página. Puedes quedarte en privado y saltártelo — Ajustes puede crearlo después.'}
                </p>
              </div>
            </div>

            <VisibilityChoice
              value={visibilityDraft}
              onChange={(value) => {
                setVisibilityDraft(value);
                setProfileError(null);
              }}
              isEnglish={isEnglish}
              idPrefix="onboarding-visibility"
            />

            {visibilityDraft === PROFILE_VISIBILITY.public && (
              <div className="onboarding-profile-fields">
                <div className="onboarding-field">
                  <Label htmlFor="onboarding-handle">{isEnglish ? 'Public handle' : 'Handle público'}</Label>
                  <div className="onboarding-handle-input">
                    <span aria-hidden="true">@</span>
                    <Input
                      id="onboarding-handle"
                      value={handleDraft}
                      onChange={event => {
                        setHandleDraft(event.target.value.toLowerCase());
                        setProfileError(null);
                      }}
                      maxLength={HANDLE_MAX_LENGTH}
                      autoComplete="username"
                      spellCheck="false"
                      required
                      aria-required="true"
                      aria-invalid={Boolean(handleDraft) && Boolean(handleError)}
                      aria-describedby="onboarding-handle-hint"
                    />
                  </div>
                  <p
                    id="onboarding-handle-hint"
                    className={`onboarding-field-hint${handleDraft && handleError ? ' is-error' : ''}`}
                    aria-live="polite"
                  >
                    {handleDraft && handleError
                      ? handleError
                      : (isEnglish
                        ? 'Lowercase letters, numbers and underscores.'
                        : 'Minúsculas, números y guiones bajos.')}
                  </p>
                </div>
                <div className="onboarding-field">
                  <Label htmlFor="onboarding-display-name">{isEnglish ? 'Display name' : 'Nombre visible'}</Label>
                  <Input
                    id="onboarding-display-name"
                    value={displayName || googleDisplayName}
                    onChange={event => setDisplayName(event.target.value)}
                    maxLength={USER_PROFILE_LIMITS.displayName}
                    autoComplete="nickname"
                    required
                    aria-required="true"
                  />
                </div>
              </div>
            )}

            {profileError && (
              <p className="onboarding-profile-error" role="alert">{profileError}</p>
            )}
          </div>
        )}
      </div>

      {/* ── Pie: el recuento vive aquí, y el botón por fin se lee ── */}
      {(step < 3 || step === 4) && (
        <footer className="onboarding-foot">
          <div className="onboarding-foot-inner">
            {step === 4 ? (
              <div className="onboarding-tally">
                <span className={`onboarding-tally-n ${canProceed ? 'is-on' : ''}`}>
                  {visibilityDraft === PROFILE_VISIBILITY.public
                    ? (isEnglish ? 'Public profile' : 'Perfil público')
                    : visibilityDraft === PROFILE_VISIBILITY.private
                      ? (isEnglish ? 'Private account' : 'Cuenta privada')
                      : (isEnglish ? 'Choose one to continue.' : 'Elige una para continuar.')}
                </span>
                <span className="onboarding-tally-hint">
                  {isEnglish
                    ? 'You can change this later in Settings.'
                    : 'Puedes cambiarlo después en Ajustes.'}
                </span>
              </div>
            ) : (
              <div className="onboarding-tally">
                <span className={`onboarding-tally-n ${canProceed ? 'is-on' : ''}`}>{tally}</span>
                <span className="onboarding-tally-hint">{hint}</span>
              </div>
            )}
            {step > 1 && (
              <button type="button" className="onboarding-btn onboarding-btn--ghost" onClick={handleBack}>
                <ArrowLeft size={15} strokeWidth={2.25} />
                {isEnglish ? 'Back' : 'Atrás'}
              </button>
            )}
            {step === 4 ? (
              <button
                type="button"
                className="onboarding-btn onboarding-btn--ink"
                onClick={handleFinish}
                disabled={!canProceed || saving}
              >
                {saving ? (
                  <span className="onboarding-spinner" />
                ) : (
                  <>
                    {isEnglish ? 'Start exploring' : 'Empezar a explorar'}
                    <ArrowRight size={15} strokeWidth={2.25} />
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                className="onboarding-btn onboarding-btn--ink"
                onClick={handleNext}
                disabled={!canProceed}
              >
                {isEnglish ? 'Next' : 'Siguiente'}
                <ArrowRight size={15} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
