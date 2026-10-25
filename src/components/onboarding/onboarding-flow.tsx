import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { SignOut } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import { toast } from 'sonner';
import { useAuth } from '../../context/auth-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { CATEGORIES } from '../../data/categories.ts';
import { useAnalyticsConsent } from '../../context/analytics-context.tsx';
import InstitutionLink from '../institution/institution-link.tsx';
import { needsUniversityProof, sendInstitutionVerification } from '../../services/institution-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import { AreaPicker, SubtopicsPicker, WelcomeCopy, WelcomeShell } from '../public/welcome-shell.tsx';
import { LibraryPreview } from '../public/guest-welcome-preferences.tsx';
import { GUEST_SEED_PER_AREA, guestSeedCategoriesForAreas, guestSeedSizeForAreas, readGuestInterests } from '../../utils/guest-interests.ts';
import { USER_PREFERENCES_MAX } from '../../utils/account-onboarding.ts';
import { Button } from '../ui/button.tsx';
import { toastError } from '../ui/toast.ts';
import Petri from './petri.tsx';
import { onboardingSaveError, onboardingSteps } from './onboarding-steps.ts';
import PetriStamp from './petri-stamp.tsx';
import './onboarding-flow.css';

const COPY = {
  progress: 'Progress',
  stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
  back: 'Back',
  saving: 'Saving…',
  finish: {
    kicker: '',
    title: 'Setting up your feed',
    lede: 'Saving the topics you picked.',
    cta: 'Try again',
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
    sent: 'Check your university inbox',
    sentDescription: (email: string) => `Open the link sent to ${email} in this browser.`,
    linked: 'University linked',
    failed: 'Could not verify your university email',
    failedDescription: (message: string) => `${message} You can try again in Settings.`,
  },
};

// The university screen's link form, which the shell's primary submits while
// an address is typed.
const UNIVERSITY_FORM_ID = 'onboarding-institution-form';

export default function OnboardingFlow() {
  // What this visitor answered before they had an account (GuestWelcome).
  // Read once: the answer is the starting point, not a live source. With
  // areas in it, those areas and topics are the preferences and the pickers
  // are not shown at all.
  // AuthContext clears the answer once completeOnboarding has written them.
  const [guestAnswer] = useState(() => readGuestInterests());
  const guestSeed = guestAnswer?.areas.length ? guestAnswer.areas : null;
  // The link field's address, kept here because the page's primary changes
  // with it: with one typed it submits the link, without one it finishes.
  const [institutionEmail, setInstitutionEmail] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const still = Boolean(useReducedMotion());
  const [stepIndex, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [selectedAreas, setSelectedAreas] = useState(() => new Set(guestSeed ?? []));
  const [selectedTopics, setSelectedTopics] = useState(() => new Set(guestAnswer?.topics ?? []));
  const [expandedAreas, setExpandedAreas] = useState(() => new Set<string>());
  // A welcome's answer starts saving on arrival (the finish screen).
  const [saving, setSaving] = useState(Boolean(guestSeed));
  const [profileError, setProfileError] = useState<string | null>(null);
  const { completeOnboarding, onboardingComplete, institution, linkInstitution, signOut } = useAuth();
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

  // An onboarded account reaches this route by signing in from the welcome.
  // It goes straight on, without drawing a greeting or counting a tutorial it
  // never began. Read at mount, so an account finishing here keeps its page
  // while it leaves.
  const [arrivedOnboarded] = useState(onboardingComplete);

  useEffect(() => {
    if (onboardingComplete) void navigate(returnTo, { replace: true });
  }, [onboardingComplete, navigate, returnTo]);

  useEffect(() => {
    if (!arrivedOnboarded) void trackEvent('tutorial_begin', { language });
  }, [arrivedOnboarded, language, trackEvent]);

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
      const ofArea = new Set(Object.keys(CATEGORIES[key].subcategories));
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

  // The address the welcome took, now that there is an account to verify it
  // for. The onboarding does not wait for it: the outcome is a toast.
  const verifyGuestUniversity = async (email: string) => {
    try {
      if (needsUniversityProof(email)) {
        await sendInstitutionVerification(email);
        toast.success(COPY.university.sent, { description: COPY.university.sentDescription(email) });
      } else {
        await linkInstitution(email);
        toast.success(COPY.university.linked);
      }
    } catch (error) {
      toastError(COPY.university.failed, {
        description: COPY.university.failedDescription(getUiErrorMessage(error, 'INSTITUTION_LINK_FAILED')),
      });
    }
  };

  const handleFinish = async () => {
    if (overCap) return;
    setSaving(true);
    setProfileError(null);
    try {
      await completeOnboarding(preferences);
      void trackEvent('tutorial_complete', { language });
      void markActivation();
      if (guestAnswer?.institutionEmail) void verifyGuestUniversity(guestAnswer.institutionEmail);
      void navigate(returnTo, { replace: true });
    } catch (err) {
      const failure = onboardingSaveError(err);
      if (failure.unexpected) console.error('Error saving preferences:', err);
      setProfileError(failure.message);
      setSaving(false);
    }
  };

  // The welcome's answer is saved as soon as the screen opens, once.
  const finishOnArrival = useEffectEvent(() => { void handleFinish(); });
  const finishStarted = useRef(false);
  useEffect(() => {
    if (step !== 'finish' || arrivedOnboarded || finishStarted.current) return;
    finishStarted.current = true;
    finishOnArrival();
  }, [step, arrivedOnboarded]);

  // The areas have to be answered. The topics do not: an area left
  // un-narrowed stands for all of it. Past the cap nothing moves forward.
  const primaryDisabled = (step === 'topics' && selectedAreas.size === 0)
    || (step !== 'topics' && overCap);

  const isLast = stepIndex === steps.length - 1;
  const stepCopy = COPY[step as 'finish' | 'topics' | 'subtopics' | 'university'];
  const petriPose = step === 'topics' ? 'flask' : undefined;
  const linksOnPress = step === 'university' && !institution && institutionEmail.trim() !== '';
  if (arrivedOnboarded) return null;
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
          onClick={() => { void signOut(); }}
        >
          <SignOut size={18} aria-hidden="true" />
        </Button>
      )}
      stepKey={step}
      direction={direction}
      still={still}
      stageClassName="gw-stage--topics"
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
      // without one, whatever is typed; while verification is running it cannot.
      skip={step === 'university' && !institution && !linkBusy
        ? { onClick: () => { if (!saving) void handleFinish(); }, label: COPY.university.skip }
        : null}
    >
      {step === 'university' && <LibraryPreview still={still} stamp={<PetriStamp />} />}

      <WelcomeCopy
        kicker={petriPose
          ? <Petri pose={petriPose} label={stepCopy.kicker} className="onboarding-petri" />
          : step === 'university' ? null : stepCopy.kicker}
        title={stepCopy.title}
        lede={stepCopy.lede}
      />

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
