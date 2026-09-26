import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check } from '@phosphor-icons/react';
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
import { GUEST_SEED_PER_AREA, guestSeedCategoriesForAreas, readGuestInterests } from '../../utils/guestInterests.js';
import { USER_PREFERENCES_MAX } from '../../utils/accountOnboarding.js';
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
  { n: '01', label: 'Areas' },
  { n: '02', label: 'Categories' },
  { n: '03', label: 'Your feed' },
  { n: '04', label: 'Profile' },
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
};

/**
 * El recibo: una fila por área con cuántas categorías entran, y el total.
 * Lo pintan el paso 3 (confirmación) y el paso 4 (perfil, cuando los
 * intereses vinieron de la respuesta de invitado): un solo componente para
 * que ambos enseñen exactamente lo que `completeOnboarding` va a escribir.
 */
function InterestsReceipt({ rows, total, available }) {
  return (
    <div className="onboarding-receipt">
      <div className="onboarding-receipt-head">
        <span>{'Area'}</span>
        <span>{'Categories'}</span>
      </div>
      {rows.map(({ key, area, count, total: areaTotal, sample, rest }) => (
        <div key={key} className="onboarding-receipt-row" style={{ '--area-accent': area.gradient }}>
          <span className="onboarding-receipt-icon"><area.icon size={19} /></span>
          <div className="onboarding-receipt-main">
            <div className="onboarding-receipt-name">{area.label}</div>
            <div className="onboarding-receipt-sample">
              {sample.join(' · ')}
              {rest > 0 && ` · +${rest} ${'more'}`}
            </div>
          </div>
          <div className="onboarding-receipt-count">
            {count}<small>{`of ${areaTotal}`}</small>
          </div>
        </div>
      ))}
      <div className="onboarding-receipt-total">
        <span>{'Total'}</span>
        <span className="onboarding-receipt-total-n">
          {total}<i> / {available}</i>
        </span>
      </div>
    </div>
  );
}

export default function OnboardingFlow() {
  // What this visitor said they were into before they had an account
  // (GuestWelcome, or the header chip's GuestInterestsPrompt). Read once: the
  // answer is the starting point, not a live source, and the areas step below
  // can change everything about it. With an answer, the interests are settled
  // — the first five categories of every area they picked, or exactly the
  // topics they narrowed an area to on the welcome
  // (`guestSeedCategoriesForAreas`) — and the flow opens on the profile step,
  // the only thing the guest has not been asked yet. The areas and categories
  // steps and the receipt stay reachable through Back, for a reader who wants
  // to narrow the pick before it is written. AuthContext clears the answer once
  // completeOnboarding has written it to the profile.
  const [guestSeed] = useState(() => {
    const stored = readGuestInterests();
    return stored?.areas.length ? stored.areas : null;
  });
  // The specific topics the welcome let them narrow an area to, if any: an
  // area narrowed there pre-selects only those categories here.
  const [guestSeedTopics] = useState(() => readGuestInterests()?.topics ?? []);
  const [stepState, setStep] = useState(guestSeed ? 4 : 1);
  const [selectedAreas, setSelectedAreas] = useState(() => new Set(guestSeed ?? []));
  const [selectedSubcategories, setSelectedSubcategories] = useState(() => new Set(guestSeedCategoriesForAreas(guestSeed ?? [], GUEST_SEED_PER_AREA, guestSeedTopics)));
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
  const { language } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const returnTo = typeof location.state?.returnTo === 'string'
    && location.state.returnTo.startsWith('/')
    && !location.state.returnTo.startsWith('//')
    ? location.state.returnTo
    : '/feed';

  const step = existingProfile && stepState > 3 ? 3 : stepState;
  const visibleSteps = existingProfile ? STEPS.slice(0, 3) : STEPS;
  const handleCheck = useMemo(() => inspectHandle(handleDraft), [handleDraft]);
  const handleError = handleCheck.valid
    ? null
    : HANDLE_ERROR_COPY.en[handleCheck.code];
  const googleDisplayName = user?.displayName
    ? String(user.displayName).slice(0, USER_PROFILE_LIMITS.displayName)
    : '';
  const resolvedDisplayName = displayName.trim() || googleDisplayName;

  // Más de esto lo rechazan las rules; el pie lo dice antes de que el botón
  // se apague, y el paso del perfil no puede acabar con una lista así.
  const overCap = selectedSubcategories.size > USER_PREFERENCES_MAX;

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
    } else if (step === 2 && selectedSubcategories.size > 0 && !overCap) {
      setStep(3);
    } else if (step === 3 && !existingProfile) {
      setStep(4);
    }
  };

  const handleBack = () => {
    // Leaving the receipt backwards is the reader taking the pick into their
    // own hands; going from the profile step back to the receipt is not.
    if (step === 3 && guestSeed) setSeedAdjusted(true);
    if (step > 1) setStep(step - 1);
  };

  // «Ajustar intereses» desde el paso del perfil: la selección pasa a ser
  // suya (la copia del recibo lo dice) y se abre el paso de categorías con
  // las áreas de la respuesta de invitado ya marcadas.
  const adjustInterests = () => {
    setSeedAdjusted(true);
    setStep(2);
  };

  const handleFinish = async () => {
    if (overCap) return;
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
        setProfileError('That handle is already taken. Try another.');
      } else if (err?.code === 'ONBOARDING_WRITE_TIMEOUT') {
        // completeOnboarding's write is a merge-set of the same fields, and
        // profileCreated (above) already stops a second profile claim, so
        // the reader's own retry is the whole recovery — nothing to do here
        // but tell them why the button stopped spinning.
        setProfileError('Still saving. Check your connection and try again.');
      } else {
        console.error('Error saving preferences:', err);
        setProfileError('Could not save. Try again.');
      }
      setSaving(false);
    }
  };

  const canProceed =
    (step === 1 && selectedAreas.size > 0) ||
    (step === 2 && selectedSubcategories.size > 0 && !overCap) ||
    step === 3 ||
    (step === 4 && !overCap && (
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
        return cat.label || cat.label;
      });
      return { key, area, count: chosen.length, total: ids.length, sample, rest: chosen.length - sample.length };
    }).filter(Boolean)
  ), [selectedAreas, selectedSubcategories]);

  const plural = (n, one, many) => (n === 1 ? one : many);

  const tally = step === 1
    ? (selectedAreas.size > 0
      ? `${selectedAreas.size} ${plural(selectedAreas.size, 'area', 'areas')} · ${availableSubcategories} ${plural(availableSubcategories, 'category', 'categories')}`
      : ('No areas selected'))
    : (selectedSubcategories.size > 0
      ? `${selectedSubcategories.size} ${plural(selectedSubcategories.size, 'category', 'categories')} · ${areasWithPicks} ${'of'} ${selectedAreas.size}`
      : ('No categories selected'));

  const hint = step === 1
    ? (selectedAreas.size > 0
      ? ('Next you pick which of those categories make it into your feed.')
      : ('Select at least one area to continue.'))
    : overCap
      ? (`At most ${USER_PREFERENCES_MAX} categories: drop ${selectedSubcategories.size - USER_PREFERENCES_MAX}.`)
      : (selectedSubcategories.size > 0
        ? ('That is enough to build your feed.')
        : ('Select at least one category to continue.'));

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
          {'Step'} <b>{visibleSteps[step - 1].n}</b> / {String(visibleSteps.length).padStart(2, '0')}
        </span>
      </header>

      <div className="onboarding-body">
        <nav className="onboarding-rail" aria-label={'Progress'}>
          {visibleSteps.map((s, i) => (
            <div
              key={s.n}
              className={`onboarding-rail-seg ${i + 1 === step ? 'is-active' : ''} ${i + 1 < step ? 'is-done' : ''}`}
              aria-current={i + 1 === step ? 'step' : undefined}
            >
              <span className="onboarding-rail-n">{s.n}</span>
              <span className="onboarding-rail-t">{s.label}</span>
            </div>
          ))}
        </nav>

        {/* ── Paso 1: las áreas ── */}
        {step === 1 && (
          <div className="onboarding-step" key="step1">
            <div className="onboarding-head">
              <div className="onboarding-head-copy">
                <span className="onboarding-eyebrow">{'Let’s begin'}</span>
                <h1 className="onboarding-title">
                  {'Choose your areas of interest'}
                </h1>
                <p className="onboarding-lede">
                  {'This is what your feed is built from. Mark the ones you care about — next you narrow down the specific categories, and you can change it any time from Settings.'}
                </p>
              </div>
              <div className="onboarding-meter">
                <span className="onboarding-meter-n">
                  {selectedAreas.size}<i>/{AREA_ENTRIES.length}</i>
                </span>
                <span className="onboarding-meter-l">{'Areas selected'}</span>
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
                      <span className="area-card-icon"><area.icon size={20} /></span>
                      <span className="area-card-count">
                        {AREA_SIZES[key]} {'cat.'}
                      </span>
                      <span className="area-card-box"><Check size={11} weight="bold" /></span>
                    </span>
                    <span className="area-card-name">
                      <span>{area.label}</span>
                    </span>
                    <span className="area-card-desc">
                      {area.description}
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
                  {selectedAreas.size} {plural(selectedAreas.size, 'area', 'areas')}
                  {' · '}
                  {availableSubcategories} {'categories available'}
                </span>
                <h1 className="onboarding-title">
                  {'Refine your interests'}
                </h1>
                <p className="onboarding-lede">
                  {'Only the categories you mark here reach your feed. The fewer you pick, the tighter it gets — and you can always add more later.'}
                </p>
              </div>
              <div className="onboarding-meter">
                <span className="onboarding-meter-n">
                  {selectedSubcategories.size}<i>/{availableSubcategories}</i>
                </span>
                <span className="onboarding-meter-l">{'Categories selected'}</span>
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
                      <span className="subcat-section-icon"><area.icon size={18} /></span>
                      <h2 className="subcat-section-title">{area.label}</h2>
                      <span className="subcat-section-count">{chosen} / {subcatIds.length}</span>
                      <button
                        type="button"
                        className={`subcat-select-all ${allSelected ? 'is-active' : ''}`}
                        onClick={() => selectAllInArea(areaKey)}
                      >
                        {allSelected
                          ? ('Deselect all')
                          : ('Select all')}
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
                            {cat.label || cat.label}
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
                  ? ('What you picked as a guest')
                  : ('Done')}
              </span>
              <h1 className="onboarding-title onboarding-title--big">
                {<>Your feed is <span>ready</span></>}
              </h1>
              <p className="onboarding-lede">
                {guestSeed && !seedAdjusted
                  ? (`We kept the ${selectedAreas.size} ${selectedAreas.size === 1 ? 'area' : 'areas'} you picked before signing in — every one of its ${selectedSubcategories.size} categories. Narrow it down now, or any time from Settings.`)
                  : (`You will see papers from the ${selectedSubcategories.size} categories you picked, ordered by what works for you. You can adjust the selection any time from Settings.`)}
              </p>
              <div className="onboarding-actions">
                {existingProfile ? (
                  <button
                    type="button"
                    className="onboarding-btn onboarding-btn--ink onboarding-btn--lg"
                    onClick={handleFinish}
                    disabled={saving || overCap}
                  >
                    {saving ? (
                      <span className="onboarding-spinner" />
                    ) : (
                      <>
                        {'Start exploring'}
                        <ArrowRight size={16} weight="bold" />
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
                    {'Next: your profile'}
                    <ArrowRight size={16} weight="bold" />
                  </button>
                )}
                <button
                  type="button"
                  className="onboarding-btn onboarding-btn--ghost"
                  onClick={handleBack}
                  disabled={saving}
                >
                  {'Adjust selection'}
                </button>
              </div>
            </div>

            <div className="onboarding-confirm-receipt">
              <InterestsReceipt
                rows={receipt}
                total={selectedSubcategories.size}
                available={availableSubcategories || TOTAL_SUBCATEGORIES}
               
              />
              <span className="onboarding-receipt-note">
                {'Saved to your profile'}
              </span>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboarding-step onboarding-step--profile" key="step4">
            <div className="onboarding-head">
              <div className="onboarding-head-copy">
                <span className="onboarding-eyebrow">{'One last thing'}</span>
                <h1 className="onboarding-title">
                  {'Do you want a public profile?'}
                </h1>
                <p className="onboarding-lede">
                  {'If you do, pick a handle. That is the name other people will see and the address of your page. You can stay private and skip this — Settings can create it later.'}
                </p>
              </div>
            </div>

            {/* Lo que vino de la respuesta de invitado, a la vista y con su
                botón: la nota de una línea que había aquí nadie la
                relacionaba con «elige tus intereses» (auditoría del 16-09). */}
            {guestSeed && (
              <section className="onboarding-seed-receipt" aria-labelledby="onboarding-seed-title">
                <div className="onboarding-seed-receipt-head">
                  <div>
                    <span className="onboarding-eyebrow" id="onboarding-seed-title">
                      {'Your interests'}
                    </span>
                    <p className="onboarding-seed-receipt-lede">
                      {seedAdjusted
                        ? ('What you chose. Adjust it here, or any time from Settings.')
                        : (`From the ${selectedAreas.size} ${selectedAreas.size === 1 ? 'area' : 'areas'} you picked as a guest: the ${selectedSubcategories.size} categories your feed starts from. Adjust them here, or any time from Settings.`)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="onboarding-btn onboarding-btn--ghost"
                    onClick={adjustInterests}
                    disabled={saving}
                  >
                    {'Adjust interests'}
                  </button>
                </div>
                <InterestsReceipt
                  rows={receipt}
                  total={selectedSubcategories.size}
                  available={availableSubcategories || TOTAL_SUBCATEGORIES}
                 
                />
              </section>
            )}

            <VisibilityChoice
              value={visibilityDraft}
              onChange={(value) => {
                setVisibilityDraft(value);
                setProfileError(null);
              }}
             
              idPrefix="onboarding-visibility"
            />

            {visibilityDraft === PROFILE_VISIBILITY.public && (
              <div className="onboarding-profile-fields">
                <div className="onboarding-field">
                  <Label htmlFor="onboarding-handle">{'Public handle'}</Label>
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
                      : ('Lowercase letters, numbers and underscores.')}
                  </p>
                </div>
                <div className="onboarding-field">
                  <Label htmlFor="onboarding-display-name">{'Display name'}</Label>
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
                    ? ('Public profile')
                    : visibilityDraft === PROFILE_VISIBILITY.private
                      ? ('Private account')
                      : ('Choose one to continue.')}
                </span>
                <span className="onboarding-tally-hint">
                  {'You can change this later in Settings.'}
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
                <ArrowLeft size={15} weight="bold" />
                {'Back'}
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
                    {'Start exploring'}
                    <ArrowRight size={15} weight="bold" />
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
                {'Next'}
                <ArrowRight size={15} weight="bold" />
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
