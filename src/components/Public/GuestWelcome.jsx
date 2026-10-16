import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  BookmarkSimple,
  CaretDown,
  CaretUp,
  Heart,
  SignIn,
  Sparkle,
  UserPlus,
} from '@phosphor-icons/react';
import { CATEGORIES } from '../../data/categories.js';
import { Button } from '../ui/button.jsx';
import { GithubMark } from '../ui/GithubMark.jsx';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import GoogleMark from './GoogleMark.jsx';
import { useProviderSignIn } from './useProviderSignIn.js';
import { CollisionNote, ProviderSpinner } from './ProviderSignIn.jsx';
import Petri from '../Onboarding/Petri.jsx';
import PetriStamp from '../Onboarding/PetriStamp.jsx';
import { normalizeGuestAreas, normalizeGuestTopics } from '../../utils/guestInterests.ts';
import { DigestPreview, WelcomeReadingChoice, WelcomeInboxChoice, WelcomeProjectSupport } from './GuestWelcomePreferences.jsx';
import { AreaPicker, SubtopicsPicker, WelcomeCopy, WelcomeShell } from './WelcomeShell.jsx';
import PrivacyPopover from './PrivacyPopover.jsx';
import Stars from './Stars.jsx';
import './GuestWelcome.css';

// The first thing a visitor sees: a page, not a sheet over a feed they have
// not read yet — and an app's first screens, not a landing page. One column,
// one idea per screen, and the way forward centred at the foot: the button,
// with back and skip as bare icons either side of it and the progress dots
// over it. The intro covers what PaperTok is, what you do in it (its three
// gestures side by side, arriving one after another), and which areas to
// build the first feed from. Reading, the optional email digest, and project
// support follow in the same layout, and then the feed itself. The areas have
// to be answered; the first two screens can skip there. Nothing here asks for
// an account, but the bar offers Sign in on every screen: someone onboarded on
// another device goes straight to their account instead of answering again.
// It offers Privacy too, so analytics can be turned off before anything else.
//
// The first screen is the landing page: the hero centred on the paper with its
// own way forward, three engravings in the corners and a few stars as it opens.
//
// Motion is decorative and runs once: every sequence, the stars included,
// settles inside five seconds and then holds still, so nothing moves beside
// the copy for longer than WCAG 2.2.2 allows without a pause control. With
// motion refused, each illustration is drawn in its final state and no star
// is drawn at all.

const STEPS = ['welcome', 'how', 'topics', 'subtopics', 'reading', 'inbox', 'support'];
const STEP_PETRI = { how: 'welcome', topics: 'flask', reading: 'reading' };
// Where the intro's skip lands: the question, not past it.
const TOPICS_INDEX = STEPS.indexOf('topics');

// How far apart the three gestures arrive. Each one's illustration starts as
// it lands, so the last is done by about 4.2s: inside the five seconds.
const BEAT_STAGGER_MS = 900;

const COPY = {
  en: {
    progress: 'Progress',
    stepOf: (n, total) => `Step ${n} of ${total}`,
    back: 'Back',
    skip: 'Skip the intro',
    welcome: {
      kicker: 'Welcome to PaperTok',
      title: <>Today’s science, <em>in one feed.</em></>,
      lede: 'Like TikTok, but you come out smarter. Five minutes a day and nothing in your field slips past you.',
      cta: 'Get started',
      or: 'or',
      signIn: 'I already have an account',
      github: 'Continue with GitHub',
      google: 'Continue with Google',
    },
    how: {
      kicker: 'Hello',
      title: 'You read science the way you scroll.',
      beats: [
        { title: 'One paper per screen', body: 'Title, authors and abstract. Swipe for the next one.' },
        { title: 'Read it in plain words', body: 'With a free account, many can be read in plain words.' },
        { title: 'Your feed learns', body: 'What you like and save decides what you see.' },
      ],
      cta: 'Choose my topics',
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
    reading: {
      kicker: 'Your reading, your way',
      title: 'How deep do you want to go?',
      lede: 'Choose your default for Read in plain words. Start simple, or keep the scientific depth.',
      cta: 'Continue',
    },
    inbox: {
      kicker: 'Your inbox',
      title: 'A little science in your inbox?',
      lede: 'Once a week, the papers worth your time from the fields you follow, in one short email.',
      cta: 'Continue',
    },
    support: {
      kicker: 'Before you dive in',
      title: 'Free for you. Powered by stars.',
      lede: 'PaperTok is free and open source. Stars are how it grows.',
      cta: 'Start exploring papers',
    },
  },
};

// ── The three gestures, one per screen, each playing its point once ──

function SwipeDemo({ still }) {
  // Three papers slide up through the frame and the third stays.
  const cards = ['var(--gradient-physics)', 'var(--gradient-med)', 'var(--gradient-cs)'];
  return (
    <div className="gw-demo gw-demo--swipe" aria-hidden="true">
      <div className="gw-demo-phone">
      <motion.div
        className="gw-demo-track"
        initial={still ? false : { y: '0%' }}
        animate={{ y: still ? '-66.666%' : ['0%', '0%', '-33.333%', '-33.333%', '-66.666%'] }}
        transition={{ duration: 2.6, times: [0, 0.25, 0.45, 0.7, 0.9], ease: 'easeInOut', delay: 0.4 }}
      >
        {cards.map((accent) => (
          <div key={accent} className="gw-demo-paper" style={{ '--area-accent': accent }}>
            <span className="gw-demo-kicker" />
            <span className="gw-demo-title" />
            <span className="gw-demo-title gw-demo-title--short" />
            <span className="gw-demo-line" />
            <span className="gw-demo-line" />
            <span className="gw-demo-line" />
            <span className="gw-demo-line" />
            <span className="gw-demo-line gw-demo-line--short" />
          </div>
        ))}
      </motion.div>
      </div>
      <motion.span
        className="gw-demo-swipe"
        initial={still ? false : { opacity: 0, y: 8 }}
        animate={still ? { opacity: 0 } : { opacity: [0, 1, 1, 0], y: [8, -10, -10, -14] }}
        transition={{ duration: 2.4, times: [0, 0.3, 0.8, 1], delay: 0.5 }}
      >
        <CaretUp size={16} weight="bold" />
      </motion.span>
    </div>
  );
}

function PlainWordsDemo({ still }) {
  // The dense abstract gives way to three short highlighted lines.
  return (
    <div className="gw-demo gw-demo--plain" aria-hidden="true">
      <div className="gw-demo-sheet">
      <motion.div
        className="gw-demo-dense"
        initial={still ? false : { opacity: 1 }}
        animate={{ opacity: still ? 0 : [1, 1, 0] }}
        transition={{ duration: 1.8, times: [0, 0.6, 1], delay: 0.8 }}
      >
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index} className="gw-demo-line gw-demo-line--dense" />
        ))}
      </motion.div>
      <div className="gw-demo-plain">
        <motion.span
          className="gw-demo-spark"
          initial={still ? false : { opacity: 0, scale: 0.6, rotate: -20 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{ duration: 0.5, delay: still ? 0 : 1.9, ease: [0.34, 1.56, 0.64, 1] }}
        >
          <Sparkle size={15} />
        </motion.span>
        {[0.92, 0.78, 0.6].map((width, index) => (
          <motion.span
            key={width}
            className="gw-demo-highlight"
            style={{ '--w': width }}
            initial={still ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.45, delay: 2.1 + index * 0.18, ease: [0.33, 1, 0.68, 1] }}
          />
        ))}
      </div>
      </div>
    </div>
  );
}

function LearnDemo({ still }) {
  // A like, a save, and the paper you liked pulls its field up the list.
  const rows = [
    { accent: 'var(--gradient-econ)', key: 'a' },
    { accent: 'var(--gradient-bio)', key: 'b' },
    { accent: 'var(--gradient-math)', key: 'c' },
  ];
  const [order, setOrder] = useState(still ? ['b', 'a', 'c'] : ['a', 'b', 'c']);
  return (
    <div className="gw-demo gw-demo--learn" aria-hidden="true">
      <div className="gw-demo-keys">
        <motion.span
          className="gw-demo-key gw-demo-key--like"
          initial={still ? false : { scale: 1 }}
          animate={still ? {} : { scale: [1, 1.25, 1] }}
          transition={{ duration: 0.45, delay: 0.9 }}
          onAnimationComplete={() => setOrder(['b', 'a', 'c'])}
        >
          <Heart size={15} />
        </motion.span>
        <motion.span
          className="gw-demo-key gw-demo-key--save"
          initial={still ? false : { scale: 1 }}
          animate={still ? {} : { scale: [1, 1.25, 1] }}
          transition={{ duration: 0.45, delay: 1.4 }}
        >
          <BookmarkSimple size={15} />
        </motion.span>
        <motion.span
          className="gw-demo-key gw-demo-key--follow"
          initial={still ? false : { scale: 1 }}
          animate={still ? {} : { scale: [1, 1.25, 1] }}
          transition={{ duration: 0.45, delay: 1.9 }}
        >
          <UserPlus size={15} />
        </motion.span>
      </div>
      <div className="gw-demo-list">
        {order.map((key) => {
          const row = rows.find(item => item.key === key);
          return (
            <motion.div
              layout={!still}
              key={key}
              className="gw-demo-row"
              style={{ '--area-accent': row.accent }}
              transition={{ layout: { duration: 0.6, ease: [0.33, 1, 0.68, 1] } }}
            >
              <span className="gw-demo-row-title" />
              <span className="gw-demo-row-line" />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

const BEAT_DEMOS = [SwipeDemo, PlainWordsDemo, LearnDemo];

// One gesture in the row. It keeps its box from the first frame — the well
// is drawn empty until its turn — so nothing shifts as the three arrive, and
// its illustration mounts when it lands, which is what starts it playing.
// The words are in the DOM throughout, so a screen reader reads all three at
// once; only their paint waits.
function Beat({ beat, index, still }) {
  const [landed, setLanded] = useState(still);
  useEffect(() => {
    if (still) return undefined;
    const timer = window.setTimeout(() => setLanded(true), index * BEAT_STAGGER_MS);
    return () => window.clearTimeout(timer);
  }, [index, still]);
  const Demo = BEAT_DEMOS[index];
  return (
    <motion.li
      className="gw-beat"
      initial={still ? false : { opacity: 0, y: 14 }}
      animate={landed ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
      transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="gw-beat-demo">
        {landed ? <Demo still={still} /> : <div className="gw-demo" aria-hidden="true" />}
      </div>
      <div className="gw-beat-copy">
        <h2 className="gw-beat-title">{beat.title}</h2>
        <p className="gw-beat-body">{beat.body}</p>
      </div>
    </motion.li>
  );
}

export default function GuestWelcome({ initialAreas = [], initialTopics = [], initialReadingLevel = 'university', initialEmailDigest = false, onComplete, onSignIn }) {
  const prefersReducedMotion = useReducedMotion();
  const still = Boolean(prefersReducedMotion);
  const copy = COPY.en;
  const [stepIndex, setStepIndex] = useState(0);
  const [readingLevel, setReadingLevel] = useState(initialReadingLevel);
  // Opt-in: off until the visitor turns it on.
  const [emailDigest, setEmailDigest] = useState(initialEmailDigest);
  const [direction, setDirection] = useState(1);
  const [leaving, setLeaving] = useState(false);
  const hero = useRef(null);

  const [shownStep, setShownStep] = useState(STEPS[0]);
  const onLanding = shownStep === 'welcome';
  // The landing's account button opens the two providers under it, in place.
  const [accountOpen, setAccountOpen] = useState(false);
  const { pendingProvider, collision, error: signInError, signIn } = useProviderSignIn('onboarding');
  const [selected, setSelected] = useState(() => new Set(normalizeGuestAreas(initialAreas)));
  const [selectedTopics, setSelectedTopics] = useState(() => new Set(normalizeGuestTopics(initialTopics, initialAreas)));
  const [expandedAreas, setExpandedAreas] = useState(() => new Set());
  const toggleExpanded = (key) => setExpandedAreas((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const step = STEPS[stepIndex];
  const stepCopy = copy[step];
  const isTopics = step === 'topics';
  const isSubtopics = step === 'subtopics';
  // The two question screens scroll under the foot and share a width.
  const isQuestion = isTopics || isSubtopics;

  const goTo = (nextIndex) => {
    if (nextIndex === stepIndex || nextIndex < 0 || nextIndex >= STEPS.length) return;
    setDirection(nextIndex > stepIndex ? 1 : -1);
    setStepIndex(nextIndex);
    // A screen is a page: it starts at the top.
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const toggleArea = (key) => {
    const removing = selected.has(key);
    setSelected((previous) => {
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

  const answer = () => {
    const areas = normalizeGuestAreas(Array.from(selected));
    return { areas, topics: normalizeGuestTopics(Array.from(selectedTopics), areas), readingLevel, emailDigest };
  };

  const finish = () => {
    if (selected.size === 0 || leaving) return;
    setLeaving(true);
    // With motion refused there is no leave to wait for.
    if (still) onComplete?.(answer());
  };

  const primary = () => {
    if (step === 'support') finish();
    else goTo(stepIndex + 1);
  };

  // The areas have to be answered. The topics do not: every area left
  // un-narrowed stands for all of it, so the last button is always live.
  const primaryDisabled = isQuestion && selected.size === 0;

  const petriPose = STEP_PETRI[step];

  const copyBlock = (
    <>
      {step === 'inbox' && <DigestPreview still={still} stamp={<PetriStamp />} />}
      <WelcomeCopy
        kicker={petriPose
          ? <Petri pose={petriPose} level={readingLevel} label={stepCopy.kicker} className="gw-petri" />
          : step === 'inbox' ? null : stepCopy.kicker}
        title={stepCopy.title}
        lede={stepCopy.lede}
      />
    </>
  );

  return (
    <WelcomeShell
      stepKey={step}
      direction={direction}
      still={still}
      leaving={leaving}
      onLeaveComplete={() => onComplete?.(answer())}
      className={onLanding ? 'gw--landing' : undefined}
      landing={onLanding}
      onStepShown={setShownStep}
      stageClassName={STEPS.indexOf(shownStep) >= TOPICS_INDEX ? 'gw-stage--topics' : undefined}
      dots={{ count: STEPS.length, index: stepIndex, label: copy.stepOf, ariaLabel: copy.progress }}
      primary={{ label: stepCopy.cta, onClick: primary, disabled: primaryDisabled }}
      back={stepIndex > 0 ? { onClick: () => goTo(stepIndex - 1), label: copy.back } : null}
      // The intro's skip lands on the question, wherever there is intro left.
      skip={stepIndex < TOPICS_INDEX ? { onClick: () => goTo(TOPICS_INDEX), label: copy.skip } : null}
      backdrop={onLanding && (
        <>
          <span className="gw-plate gw-plate--scrolls" aria-hidden="true" />
          <span className="gw-plate gw-plate--microscope" aria-hidden="true" />
          <span className="gw-plate gw-plate--lab" aria-hidden="true" />
          {!still && <Stars avoid={hero} />}
        </>
      )}
      barAction={(
        <>
          {/* Here and not in WelcomeShell: account onboarding shares the shell
              and has Settings. A visitor can object before answering anything,
              so Privacy is on the landing too. The landing carries its own
              account button, so the bar's Sign in starts on the next screen. */}
          <PrivacyPopover className="gw-bar-button" />
          {!onLanding && (
            <button type="button" className="gw-sign-in" onClick={onSignIn}>
              <SignIn size={15} aria-hidden="true" />
              Sign in
            </button>
          )}
        </>
      )}
    >
      {step === 'welcome' ? (
        <>
          <div ref={hero}>
            {copyBlock}
            <div className="gw-cta">
              <Button variant="engraved" size="lg" className="w-full" onClick={primary}>
                {copy.welcome.cta}
                <ArrowRight size={16} aria-hidden="true" />
              </Button>
              <p className="gw-or">{copy.welcome.or}</p>
              <Button
                variant="halftone"
                size="lg"
                className="w-full"
                aria-expanded={accountOpen}
                aria-controls="gw-providers"
                onClick={() => setAccountOpen(open => !open)}
              >
                {copy.welcome.signIn}
                <CaretDown size={14} weight="bold" aria-hidden="true" className="gw-account-caret" />
              </Button>
              {/* Rows grow 0fr to 1fr, so the stack opens without measuring;
                  closed it is inert, so the keyboard never lands on a hidden provider. */}
              <div id="gw-providers" className="gw-providers" data-open={accountOpen ? '' : undefined} inert={!accountOpen}>
                <div>
                  <Button variant="outline" size="lg" className="w-full" onClick={() => signIn('github')}>
                    {pendingProvider === 'github' ? <ProviderSpinner /> : <GithubMark size={18} />}
                    {copy.welcome.github}
                  </Button>
                  <Button variant="outline" size="lg" className="w-full" onClick={() => signIn('google')}>
                    {pendingProvider === 'google' ? <ProviderSpinner /> : <GoogleMark size={18} />}
                    {copy.welcome.google}
                  </Button>
                  {/* Always mounted and displayed, even empty, so the alert is a
                      live region before its text arrives. */}
                  <p className="gw-providers-note" role="alert">
                    {collision
                      ? <CollisionNote email={collision.email} />
                      : signInError ? getUiErrorMessage(signInError, 'AUTH_FAILED') : ''}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : copyBlock}

      {step === 'how' && (
        <ol className="gw-beats">
          {copy.how.beats.map((beat, index) => (
            <Beat key={beat.title} beat={beat} index={index} still={still} />
          ))}
        </ol>
      )}

      {step === 'reading' && <WelcomeReadingChoice level={readingLevel} onChange={setReadingLevel} />}
      {step === 'inbox' && <WelcomeInboxChoice subscribed={emailDigest} onChange={setEmailDigest} />}
      {step === 'support' && <WelcomeProjectSupport />}

      {isTopics && <AreaPicker selected={selected} onToggle={toggleArea} label={copy.topics.areasLabel} />}

      {isSubtopics && (
        <SubtopicsPicker
          selectedAreas={selected}
          selectedTopics={selectedTopics}
          onToggleTopic={toggleTopic}
          expandedAreas={expandedAreas}
          onToggleExpanded={toggleExpanded}
        />
      )}
    </WelcomeShell>
  );
}
