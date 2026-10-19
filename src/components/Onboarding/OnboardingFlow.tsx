import { useEffect, useMemo, useState } from 'react';
import { SignOut } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '../../context/AuthContext.tsx';
import { useLanguage } from '../../context/LanguageContext.tsx';
import { INTEREST_AREAS } from '../../data/categories.ts';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import InstitutionLink from '../Institution/InstitutionLink.tsx';
import { AreaPicker, SubtopicsPicker, WelcomeCopy, WelcomeShell } from '../Public/WelcomeShell.tsx';
import { LibraryPreview } from '../Public/GuestWelcomePreferences.tsx';
import { GUEST_SEED_PER_AREA, guestSeedCategoriesForAreas, guestSeedSizeForAreas, readGuestInterests } from '../../utils/guestInterests.ts';
import { USER_PREFERENCES_MAX } from '../../utils/accountOnboarding.ts';
import { Button } from '../ui/button.tsx';
import WELCOME_TITLE from './welcomeTitlePaths.ts';
import Petri from './Petri.tsx';
import PetriStamp from './PetriStamp.tsx';
import './OnboardingFlow.css';

// The account's first screens, drawn in the welcome's layout (WelcomeShell),
// one per screen: a greeting, the areas and the topics within them, and the
// university library. The topics are asked only of a reader who did not
// answer them on the welcome (an account opened from a shared link).
function onboardingSteps({ asksTopics }: { asksTopics: boolean }) {
  return [
    'welcome',
    ...(asksTopics ? ['topics', 'subtopics'] : []),
    'university',
  ];
}


const COPY = {
  progress: 'Progress',
  stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
  back: 'Back',
  saving: 'Saving…',
  welcome: {
    kicker: (firstName: string) => (firstName ? `Hello, ${firstName}` : 'Hello'),
    title: 'Welcome to PaperTok',
    lede: 'Your feed is ready to be yours. A few short steps and you are in.',
    cta: 'Let’s go',
  },
  topics: {
    kicker: 'Your topics',
    title: 'What are you into?',
    lede: 'This builds your feed. You can change it later.',
    areasLabel: 'Areas of interest',
    cta: 'Continue',
  },
  subtopics: {
    kicker: 'Fine-tune your feed',
    title: 'Anything more specific?',
    lede: 'The more specific, the more personal your feed.',
    cta: 'Continue',
  },
  university: {
    kicker: 'Your university',
    title: 'Do you read through a university library?',
    lede: 'Optional. Papers behind a paywall often open through your library.',
    cta: 'Start exploring',
    link: 'Continue',
    verifying: 'Verifying…',
    skip: 'Skip for now',
    linkedNote: 'You can unlink any time in Settings.',
  },
};

// The university screen's link form, which the shell's primary submits while
// an address is typed.
const UNIVERSITY_FORM_ID = 'onboarding-institution-form';

// The greeting's title, written out once as if by hand: Pinyon Script
// outlines baked into SVG (scripts/build-welcome-title.ts), so no script
// face is loaded. Each glyph is drawn filled under its own mask, a band
// leaning with the script that slides across the glyph with a soft leading
// edge, so the ink arrives stroke by stroke rather than as an outline.
// A glyph's time is its share of the ink (capitals weigh more), each begins
// as the one before is nearly done, as joined letters do, and a word gap is
// a short lift. Then the brand underline draws. Done by about 1.7 s, once.
// With motion refused the title is drawn whole and the underline in place.
// The SVG is decoration; the heading's text is the visually hidden span.
const WRITE_START = 0.6;
const WRITE_SECONDS = 1;
const CAPITAL_WEIGHT = 1.25;
const JOIN_AT = 0.88;
const WORD_GAP = 0.1;
const WRITE_EASE: [number, number, number, number] = [0.4, 0, 0.6, 1];
const RULE_GAP = 0.15;
const RULE_SECONDS = 0.35;
// The reveal's soft edge in the outlines' units; its lean is the one the
// sweeps were measured across, baked with them.
const INK_EDGE = 28;
const SLANT_DEGREES = WELCOME_TITLE.slant;

const [VIEW_X, VIEW_Y, VIEW_W, VIEW_H] = WELCOME_TITLE.viewBox.split(' ').map(Number);
const WEIGHTS = WELCOME_TITLE.glyphs.map(glyph => glyph.length * (/[A-Z]/.test(glyph.char) ? CAPITAL_WEIGHT : 1));
const TOTAL_WEIGHT = WEIGHTS.reduce((sum, weight) => sum + weight, 0);
const WRITING: { start: number; duration: number }[] = [];
for (const [index, glyph] of WELCOME_TITLE.glyphs.entries()) {
  const previous = WRITING[index - 1];
  WRITING.push({
    start: previous
      ? previous.start + previous.duration * JOIN_AT + (glyph.afterSpace ? WORD_GAP : 0)
      : WRITE_START,
    duration: (WEIGHTS[index] / TOTAL_WEIGHT) * WRITE_SECONDS,
  });
}
const WRITE_END = Math.max(...WRITING.map(({ start, duration }) => start + duration));
const RULE_START = WRITE_END + RULE_GAP;
// Shears x by the height above the baseline, as the generator's `sweep` does.
const SLANT = `translate(0 ${WELCOME_TITLE.baseline}) skewX(-${SLANT_DEGREES}) translate(0 ${-WELCOME_TITLE.baseline})`;

function ScriptTitle({ still }: { still: boolean }) {
  return (
    <span className="onboarding-script" aria-hidden="true">
      <svg className="onboarding-script-svg" viewBox={WELCOME_TITLE.viewBox} focusable="false">
        {!still && (
          <defs>
            {WELCOME_TITLE.glyphs.map((glyph, index) => {
              // The band covers the glyph's extent across the slant, plus the
              // soft edge, and starts one band-width to its left.
              const [from, to] = glyph.sweep;
              const width = to - from + INK_EDGE + 4;
              const left = from - 2;
              return (
                <g key={index}>
                  <linearGradient id={`welcome-title-ink-${index}`}>
                    <stop offset={(width - INK_EDGE) / width} stopColor="white" />
                    <stop offset={1} stopColor="white" stopOpacity={0} />
                  </linearGradient>
                  <mask
                    id={`welcome-title-mask-${index}`}
                    maskUnits="userSpaceOnUse"
                    x={VIEW_X - VIEW_W}
                    y={VIEW_Y - VIEW_H}
                    width={VIEW_W * 3}
                    height={VIEW_H * 3}
                  >
                    <g transform={SLANT}>
                      <motion.rect
                        y={VIEW_Y - VIEW_H}
                        width={width}
                        height={VIEW_H * 3}
                        fill={`url(#welcome-title-ink-${index})`}
                        initial={{ attrX: left - width }}
                        animate={{ attrX: left }}
                        transition={{ duration: WRITING[index].duration, delay: WRITING[index].start, ease: WRITE_EASE }}
                      />
                    </g>
                  </mask>
                </g>
              );
            })}
          </defs>
        )}
        {WELCOME_TITLE.glyphs.map((glyph, index) => (
          <path
            key={index}
            d={glyph.d}
            fill="currentColor"
            mask={still ? undefined : `url(#welcome-title-mask-${index})`}
          />
        ))}
      </svg>
      <motion.span
        className="onboarding-script-rule"
        initial={still ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: RULE_SECONDS, delay: RULE_START, ease: [0.33, 1, 0.68, 1] }}
      />
    </span>
  );
}


export default function OnboardingFlow() {
  // What this visitor answered before they had an account (GuestWelcome, or
  // the header chip's GuestInterestsPrompt). Read once: the answer is the
  // starting point, not a live source. With areas in it, those areas and
  // topics are the preferences and the pickers are not shown at all.
  // AuthContext clears the answer once completeOnboarding has written them.
  const [guestAnswer] = useState(() => readGuestInterests());
  const guestSeed = guestAnswer?.areas.length ? guestAnswer.areas : null;
  // The link field's address, kept here because the page's primary changes
  // with it: with one typed it submits the link, without one it finishes.
  const [institutionEmail, setInstitutionEmail] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const still = Boolean(useReducedMotion());
  const [stepIndex, setStep] = useState(0);
  // The screen actually on show: the stage's layout switches when the old
  // screen has finished leaving (WelcomeShell's onStepShown), not under it.
  const [shownStep, setShownStep] = useState('welcome');
  const [direction, setDirection] = useState(1);
  const [selectedAreas, setSelectedAreas] = useState(() => new Set(guestSeed ?? []));
  const [selectedTopics, setSelectedTopics] = useState(() => new Set(guestAnswer?.topics ?? []));
  const [expandedAreas, setExpandedAreas] = useState(() => new Set<string>());
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const { completeOnboarding, onboardingComplete, user, institution, signOut } = useAuth();
  const { language } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const returnTo = typeof location.state?.returnTo === 'string'
    && location.state.returnTo.startsWith('/')
    && !location.state.returnTo.startsWith('//')
    ? location.state.returnTo
    : '/feed';

  const asksTopics = !guestSeed;
  const steps = onboardingSteps({ asksTopics });
  const step = steps[stepIndex];
  const firstName = String(user?.displayName ?? '').trim().split(/\s+/)[0];

  // The welcome's rule, the only one: an area with topics ticked stands for
  // those, an area left whole for its first few.
  const preferences = useMemo(
    () => guestSeedCategoriesForAreas(Array.from(selectedAreas), GUEST_SEED_PER_AREA, Array.from(selectedTopics)),
    [selectedAreas, selectedTopics],
  );
  // The size before the rules' cap: past it, the seed would drop ticked topics
  // without a word, so the reader is asked to drop them instead.
  const preferenceCount = guestSeedSizeForAreas(Array.from(selectedAreas), GUEST_SEED_PER_AREA, Array.from(selectedTopics));
  // Judged only where the reader can act on it, on the pickers' path. A guest
  // answer never reaches the pickers, and its seed is cut at the rules' cap.
  const overCap = asksTopics && preferenceCount > USER_PREFERENCES_MAX;

  useEffect(() => {
    if (onboardingComplete) navigate(returnTo, { replace: true });
  }, [onboardingComplete, navigate, returnTo]);

  useEffect(() => {
    trackEvent('tutorial_begin', { language });
  }, [language, trackEvent]);

  const goTo = (nextIndex: number) => {
    if (saving || nextIndex === stepIndex || nextIndex < 0 || nextIndex >= steps.length) return;
    setDirection(nextIndex > stepIndex ? 1 : -1);
    setStep(nextIndex);
    setProfileError(null);
    // A screen is a page: it starts at the top.
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const toggleArea = (key: string) => {
    const removing = selectedAreas.has(key);
    setSelectedAreas((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // An area let go takes its topics with it, so ticking it again starts
    // from the whole area rather than from a narrowing nobody can see.
    if (removing) {
      const ofArea = new Set(Object.keys(INTEREST_AREAS[key].subcategories));
      setSelectedTopics(previous => new Set([...previous].filter(id => !ofArea.has(id))));
    }
  };

  const toggleTopic = (id: string) => {
    setSelectedTopics((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpanded = (key: string) => setExpandedAreas((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const handleFinish = async () => {
    if (overCap) return;
    setSaving(true);
    setProfileError(null);
    try {
      await completeOnboarding(preferences);
      trackEvent('tutorial_complete', { language });
      markActivation();
      navigate(returnTo, { replace: true });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ONBOARDING_WRITE_TIMEOUT') {
        // completeOnboarding's write is a merge-set of the same fields, so
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

  // The areas have to be answered. The topics do not: an area left
  // un-narrowed stands for all of it. Past the cap nothing moves forward.
  const primaryDisabled = (step === 'topics' && selectedAreas.size === 0)
    || (step !== 'topics' && overCap);

  const isLast = stepIndex === steps.length - 1;
  const stepCopy = COPY[step as 'topics' | 'subtopics' | 'university'];
  const petriPose = step === 'topics' ? 'flask' : undefined;
  // On the university screen an address typed and nothing linked yet makes
  // the primary the link's submit: Google's window has to open from a press.
  const linksOnPress = step === 'university' && !institution && institutionEmail.trim() !== '';
  return (
    <WelcomeShell
      // The way out of an account opened by mistake, beside the theme switch:
      // the same log out as the account menu, which this page does not draw.
      barAction={(
        <Button
          variant="ghost"
          size="icon"
          aria-label="Log out"
          title="Log out"
          onClick={async () => { await signOut(); navigate('/feed'); }}
        >
          <SignOut size={18} aria-hidden="true" />
        </Button>
      )}
      stepKey={step}
      direction={direction}
      still={still}
      stageClassName={shownStep === 'welcome' ? undefined : 'gw-stage--topics'}
      onStepShown={setShownStep}
      dots={{ count: steps.length, index: stepIndex, label: COPY.stepOf, ariaLabel: COPY.progress }}
      // While saving, the button stays enabled so it keeps focus; handleFinish
      // is simply not called a second time.
      // While the skip's save runs the primary is the plain one again, saying
      // so: bound to the form, a press would still start a link.
      primary={linksOnPress && !saving
        ? {
          label: linkBusy ? COPY.university.verifying : COPY.university.link,
          busy: linkBusy,
          form: UNIVERSITY_FORM_ID,
          disabled: primaryDisabled,
        }
        : {
          label: saving ? COPY.saving : stepCopy.cta,
          busy: saving,
          onClick: () => {
            if (saving) return;
            if (isLast) void handleFinish();
            else goTo(stepIndex + 1);
          },
          disabled: primaryDisabled,
        }}
      back={stepIndex > 0 ? { onClick: () => goTo(stepIndex - 1), label: COPY.back } : null}
      // Until an institution is linked the university screen can be left
      // without one, whatever is typed; while Google is open it cannot.
      skip={step === 'university' && !institution && !linkBusy
        ? { onClick: () => { if (!saving) void handleFinish(); }, label: COPY.university.skip }
        : null}
    >
      {step === 'university' && <LibraryPreview still={still} stamp={<PetriStamp />} />}

      {step === 'welcome' ? (
        <WelcomeCopy
          kicker={<Petri pose="welcome" name={firstName} label={COPY.welcome.kicker(firstName)} className="onboarding-petri" />}
          title={(
            <>
              <span className="sr-only">{COPY.welcome.title}</span>
              <ScriptTitle still={still} />
            </>
          )}
          lede={COPY.welcome.lede}
        />
      ) : (
        <WelcomeCopy
          kicker={petriPose
            ? <Petri pose={petriPose} label={stepCopy.kicker} className="onboarding-petri" />
            : step === 'university' ? null : stepCopy.kicker}
          title={stepCopy.title}
          lede={stepCopy.lede}
        />
      )}

      {step === 'topics' && <AreaPicker selected={selectedAreas} onToggle={toggleArea} label={COPY.topics.areasLabel} />}

      {step === 'subtopics' && (
        <SubtopicsPicker
          selectedAreas={selectedAreas}
          selectedTopics={selectedTopics}
          onToggleTopic={toggleTopic}
          expandedAreas={expandedAreas}
          onToggleExpanded={toggleExpanded}
        />
      )}

      {/* On every screen of the pickers' path, empty until the cap is
          passed, so the live region exists before its text arrives. */}
      {asksTopics && (
        <p className="gw-preference-note" aria-live="polite">
          {overCap
            ? `At most ${USER_PREFERENCES_MAX} categories: drop ${preferenceCount - USER_PREFERENCES_MAX}.`
            : ''}
        </p>
      )}

      {/* The university screen: the primary below submits the link. */}
      {step === 'university' && (
        <div className="gw-preferences gw-university onboarding-university">
          <InstitutionLink
            idPrefix="onboarding-institution"
            formId={UNIVERSITY_FORM_ID}
            showSubmit={false}
            email={institutionEmail}
            onEmailChange={setInstitutionEmail}
            onBusyChange={setLinkBusy}
            linkedNote={COPY.university.linkedNote}
          />
        </div>
      )}

      {profileError && (
        <p className="onboarding-profile-error" role="alert">{profileError}</p>
      )}
    </WelcomeShell>
  );
}
