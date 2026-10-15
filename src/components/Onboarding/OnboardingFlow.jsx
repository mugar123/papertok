import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Cursor, LockSimple, SignOut } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { CATEGORIES } from '../../data/categories';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import VisibilityChoice from '../Profile/VisibilityChoice.jsx';
import Handle from '../Profile/Handle.jsx';
import { AvatarPicker } from '../Profile/AvatarPicker.jsx';
import InstitutionLink from '../Institution/InstitutionLink.jsx';
import { AreaPicker, SubtopicsPicker, WelcomeCopy, WelcomeShell } from '../Public/WelcomeShell.jsx';
import { LibraryPreview } from '../Public/GuestWelcomePreferences.jsx';
import {
  HandleUnavailableError,
  PROFILE_VISIBILITY,
  USER_PROFILE_LIMITS,
  createUserProfile,
  publicAvatarFrom,
  readOwnUserProfile,
} from '../../services/userProfileService.js';
import { HANDLE_ERROR_MESSAGES, HANDLE_MAX_LENGTH, inspectHandle } from '../../utils/userHandle.js';
import { GUEST_SEED_PER_AREA, guestSeedCategoriesForAreas, guestSeedSizeForAreas, readGuestInterests } from '../../utils/guestInterests.js';
import { USER_PREFERENCES_MAX } from '../../utils/accountOnboarding.js';
import { Button } from '../ui/button.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import { Switch } from '../ui/switch.jsx';
import { Textarea } from '../ui/textarea.jsx';
import WELCOME_TITLE from './welcomeTitlePaths.js';
import Petri from './Petri.jsx';
import PetriStamp from './PetriStamp.jsx';
import './OnboardingFlow.css';

// Petri on the screens that show her in place of the kicker: looking into a
// flask over the topics, dark glasses for a private profile (PetriProfile
// reads `visibility`; the others ignore it), and thinking, a question mark
// over her head, for what to say about yourself. The handle and university
// screens open on a prop over the title instead, with Petri in it: the
// avatar in the handle's browser window (AddressWindow), a stamp on the
// university's paper (PetriStamp).
const STEP_PETRI = {
  topics: 'flask',
  profile: 'profile',
  about: 'thinking',
};

// The account's first screens, drawn in the welcome's layout (WelcomeShell),
// one per screen: a greeting, the areas and the topics within them, the
// public profile question, the handle and name of that profile, a photo and
// bio for it, and the university library. The topics are asked only of a
// reader who did not answer them on the welcome (an account opened from a
// shared link); an account that already has a profile is not asked about one
// again; and the handle, photo and bio only follow a public choice, since a
// private profile has no page to show them on.
function onboardingSteps({ asksTopics, asksProfile, asksPage }) {
  return [
    'welcome',
    ...(asksTopics ? ['topics', 'subtopics'] : []),
    ...(asksProfile ? ['profile'] : []),
    ...(asksPage ? ['handle', 'about'] : []),
    'university',
  ];
}

// The longest the list can be, which the progress dots keep room for so a
// choice that adds or removes screens does not move the dots already there.
const STEPS_AT_MOST = onboardingSteps({ asksTopics: true, asksProfile: true, asksPage: true }).length;


const COPY = {
  progress: 'Progress',
  stepOf: (n, total) => `Step ${n} of ${total}`,
  back: 'Back',
  saving: 'Saving…',
  welcome: {
    kicker: firstName => (firstName ? `Hello, ${firstName}` : 'Hello'),
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
  profile: {
    kicker: 'Your profile',
    title: 'Do you want a public profile?',
    lede: 'A public profile gives you a page of your own. Nothing is published until you finish.',
    cta: 'Continue',
  },
  handle: {
    kicker: 'Your address',
    title: 'Pick your handle',
    lede: 'It becomes the address of your page and the name people search for.',
    handleLabel: 'Public handle',
    handleHint: 'Lowercase letters, numbers and underscores.',
    nameLabel: 'Display name',
    handleTaken: 'That handle is already taken. Try another.',
    cta: 'Continue',
  },
  about: {
    kicker: 'Your page',
    title: 'Say a little about yourself',
    lede: 'Optional. A photo and a line or two; you can change both in Settings.',
    showPhoto: 'Show my account photo',
    showPhotoHint: 'Off: your page shows your initial instead of the picture.',
    bio: 'Bio',
    bioPlaceholder: 'A line or two about what you read.',
    skip: 'Skip for now',
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

// The welcome's timing (GuestWelcomePreferences): the curve its props arrive
// on, and the moment and spring with which the library card lands on its
// paper. The props here arrive the same way; the fields fade in after them.
// `initial={false}`, with motion refused, hands every part its final state.
const ARRIVE_EASE = [0.16, 1, 0.3, 1];
const CARD_AT = 0.9;
const CARD_SETTLE = 0.85;
const ARRIVE = { duration: 0.45, ease: ARRIVE_EASE, delay: 0.1 };
const LANDING = { type: 'spring', duration: CARD_SETTLE, bounce: 0.24 };
const FIELDS_AT = 0.3;

function Fields({ still, children }) {
  return (
    <motion.div
      className="onboarding-fields"
      initial={still ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: ARRIVE_EASE, delay: FIELDS_AT }}
    >
      {children}
    </motion.div>
  );
}

// The handle screen's prop, in the welcome's browser vocabulary (its GitHub
// window): the address pill reads the handle as it is typed, with a short
// dip in opacity on each change, and turns to ink once the handle is valid.
// Under the chrome, the page that address opens, as a faint skeleton. The
// welcome's cursor lands on the pill as its library card lands on the paper.
// Decoration: the field below is what assistive tech reads.
function AddressWindow({ handle, valid, still }) {
  return (
    <motion.div
      className="gw-gh onboarding-window"
      aria-hidden="true"
      initial={still ? false : { opacity: 0, transform: 'translateY(16px)' }}
      animate={{ opacity: 1, transform: 'translateY(0px)' }}
      transition={ARRIVE}
    >
      <div className="gw-gh-chrome">
        <span className="gw-gh-dots"><i /><i /><i /></span>
        <span className="gw-gh-url">
          <LockSimple size={9} weight="fill" />
          <span className="onboarding-window-address" data-valid={valid ? '' : undefined}>
            <motion.span
              key={handle}
              initial={still ? false : { opacity: 0.35 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
            >
              papertok.app/<Handle handle={handle || 'yourhandle'} />
            </motion.span>
          </span>
          <motion.span
            className="gw-gh-cursor onboarding-window-cursor"
            initial={still ? false : { opacity: 0, transform: 'translate(40px, 32px)' }}
            animate={{ opacity: 1, transform: 'translate(0px, 0px)' }}
            transition={{ ...LANDING, delay: CARD_AT, opacity: { duration: 0.2, delay: CARD_AT } }}
          >
            <Cursor size={15} weight="fill" />
          </motion.span>
        </span>
      </div>
      <div className="onboarding-window-page">
        {/* The page's avatar is Petri, smiling: a close-up of her face that
            fills the circle, as a profile picture would. */}
        <span className="onboarding-window-avatar">
          <svg viewBox="54 74 52 52" focusable="false">
            <rect x="54" y="74" width="52" height="52" fill="var(--brand-yellow)" />
            <circle cx="70" cy="90" r="3.6" fill="var(--text-on-brand)" />
            <circle cx="90" cy="90" r="3.6" fill="var(--text-on-brand)" />
            <path d="M73 99q7 6 14 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
        </span>
        <span className="onboarding-window-bar" />
        <span className="onboarding-window-bar onboarding-window-bar--short" />
        <span className="onboarding-window-tabs">
          <span className="is-active"><i /></span>
          <span><i /></span>
          <span><i /></span>
        </span>
      </div>
    </motion.div>
  );
}


// The greeting's title, written out once as if by hand: Pinyon Script
// outlines baked into SVG (scripts/build-welcome-title.mjs), so no script
// face is loaded. Each glyph is drawn filled under its own mask, a band
// leaning with the script that slides across the glyph with a soft leading
// edge, so the ink arrives stroke by stroke rather than as an outline.
// A glyph's time is its share of the ink (capitals weigh more), each begins
// as the one before is nearly done, as joined letters do, and a word gap is
// a short lift. Then the brand underline draws. Done by about 1.7 s, once.
// With motion refused the title is drawn whole and the underline in place.
// The SVG is decoration; the heading's text is the visually hidden span.
// The pen starts as Petri has risen onto its dish (OnboardingFlow.css).
const WRITE_START = 0.6;
const WRITE_SECONDS = 1;
const CAPITAL_WEIGHT = 1.25;
const JOIN_AT = 0.88;
const WORD_GAP = 0.1;
const WRITE_EASE = [0.4, 0, 0.6, 1];
const RULE_GAP = 0.15;
const RULE_SECONDS = 0.35;
// The reveal's soft edge in the outlines' units; its lean is the one the
// sweeps were measured across, baked with them.
const INK_EDGE = 28;
const SLANT_DEGREES = WELCOME_TITLE.slant;

const [VIEW_X, VIEW_Y, VIEW_W, VIEW_H] = WELCOME_TITLE.viewBox.split(' ').map(Number);
const WEIGHTS = WELCOME_TITLE.glyphs.map(glyph => glyph.length * (/[A-Z]/.test(glyph.char) ? CAPITAL_WEIGHT : 1));
const TOTAL_WEIGHT = WEIGHTS.reduce((sum, weight) => sum + weight, 0);
const WRITING = [];
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

function ScriptTitle({ still }) {
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
  const [stepState, setStep] = useState(0);
  // The screen actually on show: the stage's layout switches when the old
  // screen has finished leaving (WelcomeShell's onStepShown), not under it.
  const [shownStep, setShownStep] = useState('welcome');
  const [direction, setDirection] = useState(1);
  const [selectedAreas, setSelectedAreas] = useState(() => new Set(guestSeed ?? []));
  const [selectedTopics, setSelectedTopics] = useState(() => new Set(guestAnswer?.topics ?? []));
  const [expandedAreas, setExpandedAreas] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [visibilityDraft, setVisibilityDraft] = useState(null);
  const [handleDraft, setHandleDraft] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileError, setProfileError] = useState(null);
  const [existingProfile, setExistingProfile] = useState(false);
  const [bio, setBio] = useState('');
  // The chosen photo, prepared twice as Settings does: the account's copy
  // (navbar) and the smaller public one.
  const [photo, setPhoto] = useState(null);
  // On by default, as in the profile editor; off publishes the initial.
  const [showAccountPhoto, setShowAccountPhoto] = useState(true);
  // Set the moment createUserProfile succeeds. A retry after a failed
  // completeOnboarding must skip the create: the handle is already this
  // account's, and a second create hits its own reservation as "taken".
  const profileCreated = useRef(false);
  const { completeOnboarding, onboardingComplete, updateProfilePhoto, user, institution, signOut } = useAuth();
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
  const asksPage = !existingProfile && visibilityDraft === PROFILE_VISIBILITY.public;
  const steps = onboardingSteps({ asksTopics, asksProfile: !existingProfile, asksPage });
  // Every change to the list happens at or after the current screen: the
  // profile read settling (a reader already on the profile screen lands on
  // the one that took its place) and the visibility choice, made on the
  // screen just before the handle and about screens it adds or removes.
  const stepIndex = Math.min(stepState, steps.length - 1);
  const step = steps[stepIndex];
  const handleCheck = useMemo(() => inspectHandle(handleDraft), [handleDraft]);
  const handleError = handleCheck.valid
    ? null
    : HANDLE_ERROR_MESSAGES[handleCheck.code];
  const googleDisplayName = user?.displayName
    ? String(user.displayName).slice(0, USER_PROFILE_LIMITS.displayName)
    : '';
  const resolvedDisplayName = displayName.trim() || googleDisplayName;
  const firstName = googleDisplayName.trim().split(/\s+/)[0];
  // What the public page will show, and so what the preview shows: the
  // chosen photo, else the account's unless switched off, else nothing (the
  // initial).
  const accountPhoto = publicAvatarFrom(null, user?.photoURL);
  const publicPhoto = photo?.public || (showAccountPhoto ? accountPhoto : '');

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
    let active = true;
    readOwnUserProfile()
      .then(profile => { if (active) setExistingProfile(Boolean(profile)); })
      .catch(() => { if (active) setExistingProfile(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    trackEvent('tutorial_begin', { language });
  }, [language, trackEvent]);

  const goTo = (nextIndex) => {
    if (saving || nextIndex === stepIndex || nextIndex < 0 || nextIndex >= steps.length) return;
    setDirection(nextIndex > stepIndex ? 1 : -1);
    setStep(nextIndex);
    setProfileError(null);
    // A screen is a page: it starts at the top.
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const toggleArea = (key) => {
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

  const toggleTopic = (id) => {
    setSelectedTopics((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpanded = (key) => setExpandedAreas((previous) => {
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
      if (!existingProfile && !profileCreated.current && visibilityDraft === PROFILE_VISIBILITY.public) {
        if (!handleCheck.valid || !resolvedDisplayName) {
          setSaving(false);
          return;
        }
        await createUserProfile({
          handle: handleCheck.handle,
          displayName: resolvedDisplayName,
          bio,
          allowContact: false,
          photo: publicPhoto,
          // The page shows a photo exactly when one was chosen or the account's
          // was left on; stored, so a hidden photo is not mistaken for none.
          showPhoto: Boolean(publicPhoto),
          visibility: PROFILE_VISIBILITY.public,
          institution,
        });
        profileCreated.current = true;
      }
      // The navbar shows the account's copy, as after a change in Settings.
      // Repeating it on a retry writes the same value again.
      if (asksPage && photo) await updateProfilePhoto(photo.account);
      await completeOnboarding(preferences);
      trackEvent('tutorial_complete', { language });
      markActivation();
      navigate(returnTo, { replace: true });
    } catch (err) {
      if (err instanceof HandleUnavailableError) {
        // The handle is fixed on its own screen, so that is where the reader
        // is taken, with the reason under the field.
        setDirection(-1);
        setStep(steps.indexOf('handle'));
        setProfileError(COPY.handle.handleTaken);
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

  // The areas have to be answered, the profile question chosen and, for a
  // public profile, a valid handle and a name given. The topics do not: an
  // area left un-narrowed stands for all of it. Past the cap nothing moves
  // forward.
  const primaryDisabled = (step === 'topics' && selectedAreas.size === 0)
    || (step !== 'topics' && overCap)
    || (step === 'profile' && !visibilityDraft)
    || (step === 'handle' && !(handleCheck.valid && resolvedDisplayName));

  const isLast = stepIndex === steps.length - 1;
  const stepCopy = COPY[step];
  const petriPose = STEP_PETRI[step];
  const handleTaken = step === 'handle' && profileError === COPY.handle.handleTaken;
  const handleInvalid = handleTaken || (Boolean(handleDraft) && Boolean(handleError));
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
      dots={{ count: steps.length, index: stepIndex, max: STEPS_AT_MOST, label: COPY.stepOf, ariaLabel: COPY.progress }}
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
      // Skipping the page screen means none of it: what was typed or chosen
      // there is dropped, so nothing reaches the public profile unasked.
      skip={step === 'about'
        ? { onClick: () => { setBio(''); setPhoto(null); goTo(stepIndex + 1); }, label: COPY.about.skip }
        : step === 'university' && !institution && !linkBusy
          ? { onClick: () => { if (!saving) void handleFinish(); }, label: COPY.university.skip }
          : null}
    >
      {/* The handle and university screens open on their prop, over the
          title where the other screens' kicker is: the page the handle makes,
          and the paper a library opens, stamped with Petri. */}
      {step === 'handle' && <AddressWindow handle={handleDraft} valid={handleCheck.valid && !handleTaken} still={still} />}
      {step === 'university' && <LibraryPreview still={still} stamp={<PetriStamp />} />}

      {step === 'welcome' ? (
        <WelcomeCopy
          // Petri holds up the reader's first name, and says the hello for it.
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
          // On these screens Petri stands in for the kicker (STEP_PETRI).
          kicker={petriPose
            ? <Petri pose={petriPose} visibility={visibilityDraft} label={stepCopy.kicker} className="onboarding-petri" />
            : step === 'handle' || step === 'university' ? null : stepCopy.kicker}
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

      {step === 'profile' && (
        <div className="gw-preferences onboarding-profile">
          <VisibilityChoice
            value={visibilityDraft}
            onChange={(value) => {
              setVisibilityDraft(value);
              setProfileError(null);
            }}
            idPrefix="onboarding-visibility"
          />
        </div>
      )}

      {/* The handle screen's field, under the title (its window is above). */}
      {step === 'handle' && (
        <div className="gw-preferences onboarding-handle">
          <Fields still={still}>
            <div className="onboarding-field">
              <Label htmlFor="onboarding-handle">{COPY.handle.handleLabel}</Label>
              <div className="onboarding-handle-input">
                <span aria-hidden="true">@</span>
                <Input
                  id="onboarding-handle"
                  value={handleDraft}
                  onChange={event => {
                    setHandleDraft(event.target.value.toLowerCase());
                    setProfileError(null);
                  }}
                  placeholder="yourhandle"
                  maxLength={HANDLE_MAX_LENGTH}
                  autoComplete="username"
                  spellCheck="false"
                  required
                  aria-required="true"
                  aria-invalid={handleInvalid}
                  aria-describedby="onboarding-handle-hint"
                />
              </div>
              <p
                id="onboarding-handle-hint"
                className={`onboarding-field-hint${handleInvalid ? ' is-error' : ''}`}
                aria-live="polite"
              >
                {handleTaken
                  ? COPY.handle.handleTaken
                  : handleDraft && handleError
                    ? handleError
                    : COPY.handle.handleHint}
              </p>
            </div>
            <div className="onboarding-field">
              <Label htmlFor="onboarding-display-name">{COPY.handle.nameLabel}</Label>
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
          </Fields>
        </div>
      )}

      {/* The about screen: the photo is the object, landing as the welcome's
          library card does, with the name it will stand beside; the switch
          and the bio are the controls under it. */}
      {step === 'about' && (
        <div className="gw-preferences onboarding-about">
          <motion.div
            className="onboarding-avatar"
            // The screens' own arrival (ARRIVE), like the handle's window
            // and the university's paper.
            initial={still ? false : { opacity: 0, transform: 'translateY(16px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            transition={ARRIVE}
          >
            {/* The shared picker prepares both copies (with the crop) before
                it calls onChange, so there is nothing to wait for here. */}
            <AvatarPicker
              value={photo}
              fallbackSrc={showAccountPhoto ? accountPhoto : ''}
              initial={resolvedDisplayName.trim().charAt(0).toUpperCase()}
              size={120}
              disabled={saving}
              onChange={setPhoto}
            />
          </motion.div>
          <p className="onboarding-about-name">{resolvedDisplayName}</p>
          <Fields still={still}>
            {/* The editor's switch, with its copy: a chosen photo replaces it. */}
            {accountPhoto && !photo && (
              <Label className="onboarding-switch">
                <span className="onboarding-switch-copy">
                  <span className="onboarding-switch-label">{COPY.about.showPhoto}</span>
                  <span className="onboarding-switch-hint">{COPY.about.showPhotoHint}</span>
                </span>
                <Switch checked={showAccountPhoto} onCheckedChange={setShowAccountPhoto} />
              </Label>
            )}
            <div className="onboarding-field">
              <div className="onboarding-field-head">
                <Label htmlFor="onboarding-bio">{COPY.about.bio}</Label>
                <span id="onboarding-bio-count" className="onboarding-bio-count">
                  {bio.length} / {USER_PROFILE_LIMITS.bio}
                </span>
              </div>
              <Textarea
                id="onboarding-bio"
                value={bio}
                rows={3}
                placeholder={COPY.about.bioPlaceholder}
                onChange={event => setBio(event.target.value)}
                maxLength={USER_PROFILE_LIMITS.bio}
                aria-describedby="onboarding-bio-count"
              />
            </div>
          </Fields>
        </div>
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

      {/* The taken handle is shown and announced by the field's own hint. */}
      {profileError && !handleTaken && (
        <p className="onboarding-profile-error" role="alert">{profileError}</p>
      )}
    </WelcomeShell>
  );
}
