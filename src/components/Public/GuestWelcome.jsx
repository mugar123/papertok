import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  BookmarkSimple,
  CaretDown,
  CaretUp,
  Check,
  Heart,
  SignIn,
  SkipForward,
  Sparkle,
  UserPlus,
} from '@phosphor-icons/react';
import { CATEGORIES } from '../../data/categories.js';
import { normalizeGuestAreas, normalizeGuestTopics } from '../../utils/guestInterests.js';
import ThemeToggle from '../Layout/ThemeToggle.jsx';
import { Button } from '../ui/button.jsx';
import { Toggle } from '../ui/toggle.jsx';
import './GuestWelcome.css';

// The first thing a visitor sees: a page, not a sheet over a feed they have
// not read yet — and an app's first screens, not a landing page. One column,
// one idea per screen, and the way forward centred at the foot: the button,
// with back and skip as bare icons either side of it and the progress dots
// over it. Three screens — what PaperTok is, what you do in it (its three
// gestures side by side, arriving one after another), and which areas to
// build the first feed from — and then the feed itself. The last screen has
// to be answered (the feed is built from it); the first two can skip there.
//
// The papers drifting past the first screen are real ones
// (guestWelcome.test.js holds each to a complete citation).
//
// Motion is decorative and runs once: every sequence settles inside five
// seconds and then holds still, so nothing moves alongside the copy for
// longer than WCAG 2.2.2 allows without a pause control. With motion refused,
// each illustration is drawn in its final state.

const AREA_ENTRIES = Object.entries(CATEGORIES);

// The papers the welcome's two columns scroll through. Decoration, not feed
// data — the feed only ever shows what the providers return — but real
// papers, with the titles, authors and years they were published under, so
// nothing on the first screen is invented. Heavy on recent AI, which is what
// most visitors arrive wanting, and interleaved with landmarks from the other
// fields so each column still reads as all of science. `topic` is the arXiv
// category the paper is filed under, and its label comes from the taxonomy.
const SHOWCASE_LEFT = [
  { field: 'cs', topic: 'cs.CL', title: 'Attention Is All You Need', authors: 'Vaswani et al.', year: 2017 },
  { field: 'physics', title: 'Observation of Gravitational Waves from a Binary Black Hole Merger', authors: 'LIGO Scientific and Virgo Collaborations', year: 2016 },
  { field: 'cs', topic: 'cs.CL', title: 'Language Models are Few-Shot Learners', authors: 'Brown et al.', year: 2020 },
  { field: 'bio', title: 'Highly accurate protein structure prediction with AlphaFold', authors: 'Jumper et al.', year: 2021 },
  { field: 'cs', topic: 'cs.CL', title: 'Chain-of-Thought Prompting Elicits Reasoning in Large Language Models', authors: 'Wei et al.', year: 2022 },
  { field: 'cs', topic: 'cs.CV', title: 'High-Resolution Image Synthesis with Latent Diffusion Models', authors: 'Rombach et al.', year: 2022 },
  { field: 'q-fin', title: 'The Pricing of Options and Corporate Liabilities', authors: 'Black & Scholes', year: 1973 },
  { field: 'cs', topic: 'cs.LG', title: 'Direct Preference Optimization: Your Language Model is Secretly a Reward Model', authors: 'Rafailov et al.', year: 2023 },
  { field: 'eess', title: 'A Mathematical Theory of Communication', authors: 'Shannon', year: 1948 },
  { field: 'cs', topic: 'cs.AI', title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning', authors: 'DeepSeek-AI', year: 2025 },
  { field: 'cs', topic: 'cs.CV', title: 'Segment Anything', authors: 'Kirillov et al.', year: 2023 },
  { field: 'math', title: 'The entropy formula for the Ricci flow and its geometric applications', authors: 'Perelman', year: 2002 },
  { field: 'cs', topic: 'cs.LG', title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness', authors: 'Dao et al.', year: 2022 },
  { field: 'econ', title: 'Prospect Theory: An Analysis of Decision under Risk', authors: 'Kahneman & Tversky', year: 1979 },
  { field: 'cs', topic: 'cs.CV', title: 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale', authors: 'Dosovitskiy et al.', year: 2021 },
  { field: 'mech', title: 'A Robust Layered Control System for a Mobile Robot', authors: 'Brooks', year: 1986 },
];

const SHOWCASE_RIGHT = [
  { field: 'cs', topic: 'cs.CL', title: 'Training language models to follow instructions with human feedback', authors: 'Ouyang et al.', year: 2022 },
  { field: 'med', title: 'Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine', authors: 'Polack et al.', year: 2020 },
  { field: 'cs', topic: 'cs.CV', title: 'Deep Residual Learning for Image Recognition', authors: 'He et al.', year: 2016 },
  { field: 'bio', title: 'A Programmable Dual-RNA–Guided DNA Endonuclease in Adaptive Bacterial Immunity', authors: 'Jinek et al.', year: 2012 },
  { field: 'cs', topic: 'cs.CV', title: 'Learning Transferable Visual Models From Natural Language Supervision', authors: 'Radford et al.', year: 2021 },
  { field: 'cs', topic: 'cs.CL', title: 'LLaMA: Open and Efficient Foundation Language Models', authors: 'Touvron et al.', year: 2023 },
  { field: 'stat', title: 'Regression Shrinkage and Selection via the Lasso', authors: 'Tibshirani', year: 1996 },
  { field: 'cs', topic: 'cs.LG', title: 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces', authors: 'Gu & Dao', year: 2023 },
  { field: 'physics', title: 'Quantum supremacy using a programmable superconducting processor', authors: 'Arute et al.', year: 2019 },
  { field: 'cs', topic: 'cs.CL', title: 'Constitutional AI: Harmlessness from AI Feedback', authors: 'Bai et al.', year: 2022 },
  { field: 'cs', topic: 'cs.CL', title: 'Toolformer: Language Models Can Teach Themselves to Use Tools', authors: 'Schick et al.', year: 2023 },
  { field: 'chemeng', title: 'Electric Field Effect in Atomically Thin Carbon Films', authors: 'Novoselov et al.', year: 2004 },
  { field: 'cs', topic: 'cs.CL', title: 'LoRA: Low-Rank Adaptation of Large Language Models', authors: 'Hu et al.', year: 2022 },
  { field: 'cs', topic: 'cs.LG', title: 'Scaling Laws for Neural Language Models', authors: 'Kaplan et al.', year: 2020 },
  { field: 'civil', title: 'The Tragedy of the Commons', authors: 'Hardin', year: 1968 },
  { field: 'cs', topic: 'cs.LG', title: 'Denoising Diffusion Probabilistic Models', authors: 'Ho, Jain & Abbeel', year: 2020 },
];

// Seconds per card on screen: the loop's length follows the list, so adding a
// paper does not speed the column up.
const STREAM_SECONDS_PER_PAPER = 7;

const STEPS = ['welcome', 'how', 'topics', 'subtopics'];
// Where the intro's skip lands: the question, not past it.
const TOPICS_INDEX = STEPS.indexOf('topics');

// How many of an area's topics show before "Show more": two rows of the
// three-column grid. An area with only a couple past that shows them all —
// a button to reveal one or two cards costs more than the cards.
const SUBTOPICS_SHOWN = 6;
const SUBTOPICS_FOLD_MIN = SUBTOPICS_SHOWN + 3;

// How far apart the three gestures arrive. Each one's illustration starts as
// it lands, so the last is done by about 4.2s: inside the five seconds.
const BEAT_STAGGER_MS = 900;

const COPY = {
  en: {
    progress: 'Progress',
    stepOf: (n, total) => `Step ${n} of ${total}`,
    signIn: 'Sign in',
    signInName: 'Sign in to your account',
    back: 'Back',
    skip: 'Skip the intro',
    pauseMotion: 'Pause the moving papers',
    welcome: {
      kicker: 'Welcome to PaperTok',
      title: 'Today’s science, in one feed.',
      lede: 'Like TikTok, but you come out smarter. Five minutes a day and nothing in your field slips past you.',
      cta: 'Get started',
    },
    how: {
      kicker: 'What you do here',
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
      topicsOf: area => `${area} topics`,
      showMore: n => `Show ${n} more`,
      showLess: 'Show less',
      cta: 'Show my feed',
    },
  },
};

// One of the welcome's two columns: a loop of paper cards drifting past on
// their own. The list is drawn twice and the track travels exactly half its
// height (or width, on a phone), so the seam never shows.
//
// Anything that moves by itself for more than five seconds beside the copy
// has to be stoppable (WCAG 2.2.2). There is no pause button on screen and a
// pointer passing over does not stop it; the column itself is the control, a
// toggle — click, tap, or Tab to it and press Enter — that stops both. The cards are decoration and hidden from assistive tech;
// the toggle is what a screen reader meets, by name and pressed state.
function PaperStream({ papers, reverse = false, paused, onToggle, toggleLabel, still }) {
  return (
    <div className={`gw-stream-col${paused ? ' is-paused' : ''}`}>
      <div className={`gw-stream${reverse ? ' gw-stream--reverse' : ''}`} aria-hidden="true">
        <div className="gw-stream-track" style={{ '--stream-duration': `${papers.length * STREAM_SECONDS_PER_PAPER}s` }}>
          {[...papers, ...papers].map((paper, index) => {
            const area = CATEGORIES[paper.field];
            const topic = paper.topic ? area.subcategories[paper.topic] : null;
            const label = topic ?? area;
            return (
              <div key={index} className="gw-stream-card" style={{ '--area-accent': area.gradient }}>
                <p className="gw-stream-meta">
                  <span>{label.label}</span>
                  <span className="gw-stream-dot">·</span>
                  <span>{paper.year}</span>
                </p>
                <p className="gw-stream-title" lang="en">{paper.title}</p>
                <p className="gw-stream-authors">{paper.authors}</p>
              </div>
            );
          })}
        </div>
      </div>
      {!still && (
        <button
          type="button"
          className="gw-stream-hit"
          aria-pressed={paused}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggle}
        />
      )}
    </div>
  );
}

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

export default function GuestWelcome({ initialAreas = [], initialTopics = [], onComplete, onSignIn }) {
  const prefersReducedMotion = useReducedMotion();
  const still = Boolean(prefersReducedMotion);
  const copy = COPY.en;
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [leaving, setLeaving] = useState(false);
  const [streamsPaused, setStreamsPaused] = useState(false);
  const toggleStreams = useCallback(() => setStreamsPaused(paused => !paused), []);
  const [selected, setSelected] = useState(() => new Set(normalizeGuestAreas(initialAreas)));
  const [selectedTopics, setSelectedTopics] = useState(() => new Set(normalizeGuestTopics(initialTopics, initialAreas)));
  const [expandedAreas, setExpandedAreas] = useState(() => new Set());
  const toggleExpanded = (key) => setExpandedAreas((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  // The heading of a screen takes focus when the reader moves to it, so a
  // screen reader starts reading the new screen and a keyboard user starts
  // tabbing from its top. Not on the first paint: that is the page loading,
  // and the route announcer already speaks for it.
  const focusHeadingRef = useRef(false);
  const headingRef = useCallback((element) => {
    if (element && focusHeadingRef.current) {
      focusHeadingRef.current = false;
      element.focus({ preventScroll: true });
    }
  }, []);

  const step = STEPS[stepIndex];
  const stepCopy = copy[step];
  const isTopics = step === 'topics';
  const isSubtopics = step === 'subtopics';
  // The two question screens scroll under the foot and share a width.
  const isQuestion = isTopics || isSubtopics;

  const goTo = (nextIndex) => {
    if (nextIndex === stepIndex || nextIndex < 0 || nextIndex >= STEPS.length) return;
    setDirection(nextIndex > stepIndex ? 1 : -1);
    focusHeadingRef.current = true;
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
    return { areas, topics: normalizeGuestTopics(Array.from(selectedTopics), areas) };
  };

  const finish = () => {
    if (selected.size === 0 || leaving) return;
    setLeaving(true);
    // With motion refused there is no leave to wait for.
    if (still) onComplete?.(answer());
  };

  const primary = () => {
    if (isSubtopics) finish();
    else goTo(stepIndex + 1);
  };

  // Variants with `custom`, so the screen that is leaving reads the direction
  // of the move that is happening now — a prop captured when it last rendered
  // would send it out the way the PREVIOUS move went.
  const stepVariants = still
    ? {
      enter: { opacity: 1 },
      center: { opacity: 1 },
      exit: { opacity: 0, transition: { duration: 0 } },
    }
    : {
      enter: (dir) => ({ opacity: 0, x: dir * 28 }),
      center: { opacity: 1, x: 0, transition: { duration: 0.34, ease: [0.33, 1, 0.68, 1] } },
      exit: (dir) => ({ opacity: 0, x: dir * -28, transition: { duration: 0.18, ease: [0.32, 0, 0.67, 0] } }),
    };

  // The areas have to be answered. The topics do not: every area left
  // un-narrowed stands for all of it, so the last button is always live.
  const primaryDisabled = isQuestion && selected.size === 0;

  const copyBlock = (
    <div className="gw-copy">
      <p className="gw-kicker">{stepCopy.kicker}</p>
      <h1 className="gw-title" ref={headingRef} tabIndex={-1}>{stepCopy.title}</h1>
      {stepCopy.lede && <p className="gw-lede">{stepCopy.lede}</p>}
    </div>
  );

  return (
    <motion.main
      className={`gw${step === 'welcome' ? ' gw--showcase' : ''}`}
      animate={leaving && !still ? { opacity: 0, y: -16 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.32, 0, 0.67, 0] }}
      onAnimationComplete={() => {
        if (leaving && !still) onComplete?.(answer());
      }}
    >
      <header className="gw-bar">
        <div className="gw-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
        <div className="gw-bar-actions">
          <ThemeToggle className="gw-bar-button" />
          <Button variant="ghost" size="sm" onClick={onSignIn} aria-label={copy.signInName}>
            <SignIn size={15} aria-hidden="true" />
            <span className="gw-sign-in-label">{copy.signIn}</span>
          </Button>
        </div>
      </header>

      <div className={`gw-stage${isQuestion ? ' gw-stage--topics' : ''}`}>
        {/* No `initial={false}` here: AnimatePresence hands it down to every
            motion component inside, and the illustrations would mount already
            finished. */}
        <AnimatePresence mode="wait" custom={direction}>
          <motion.section
            key={step}
            className={`gw-step gw-step--${step}`}
            custom={direction}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {step === 'welcome' ? (
              <div className="gw-showcase">
                <PaperStream
                  papers={SHOWCASE_LEFT}
                  paused={streamsPaused}
                  onToggle={toggleStreams}
                  toggleLabel={copy.pauseMotion}
                  still={still}
                 
                />
                {copyBlock}
                <PaperStream
                  papers={SHOWCASE_RIGHT}
                  reverse
                  paused={streamsPaused}
                  onToggle={toggleStreams}
                  toggleLabel={copy.pauseMotion}
                  still={still}
                 
                />
              </div>
            ) : copyBlock}

            {step === 'how' && (
              <ol className="gw-beats">
                {copy.how.beats.map((beat, index) => (
                  <Beat key={beat.title} beat={beat} index={index} still={still} />
                ))}
              </ol>
            )}

            {isTopics && (
              <div className="gw-areas" role="group" aria-label={copy.topics.areasLabel}>
                {AREA_ENTRIES.map(([key, area], index) => (
                  // The shared Toggle: a native button carrying
                  // `aria-pressed` and `data-pressed`, which the CSS reads.
                  <Toggle
                    key={key}
                    variant="outline"
                    className="gw-area"
                    pressed={selected.has(key)}
                    onPressedChange={() => toggleArea(key)}
                    style={{ '--area-accent': area.gradient, '--i': index }}
                  >
                    <span className="gw-area-icon" aria-hidden="true">
                      <area.icon size={20} weight={selected.has(key) ? 'fill' : 'regular'} />
                    </span>
                    <span className="gw-area-name">{area.label}</span>
                    <span className="gw-area-box" aria-hidden="true">
                      <Check size={11} weight="bold" />
                    </span>
                  </Toggle>
                ))}
              </div>
            )}

            {/* The areas' specific topics, a screen of their own: the
                taxonomy's subcategories — the same ids a member's preferences
                hold and the feed plan routes by — drawn as the same cards as
                the areas, one group per area ticked on the screen before, in
                its colour and with its glyph. */}
            {isSubtopics && AREA_ENTRIES.filter(([key]) => selected.has(key)).map(([key, area]) => {
              const areaLabel = area.label;
              const entries = Object.entries(area.subcategories);
              const folds = entries.length >= SUBTOPICS_FOLD_MIN;
              const expanded = !folds || expandedAreas.has(key);
              // Folded, the first few show — plus anything already picked
              // further down, so a choice never hides behind the fold.
              const shown = expanded
                ? entries
                : entries.filter(([id], index) => index < SUBTOPICS_SHOWN || selectedTopics.has(id));
              const hidden = entries.length - shown.length;
              const gridId = `gw-subtopics-${key}`;
              return (
                <section key={key} className="gw-subtopics" aria-label={copy.subtopics.topicsOf(areaLabel)}>
                  <h2 className="gw-subtopics-title" style={{ '--area-accent': area.gradient }}>
                    <area.icon size={18} weight="fill" aria-hidden="true" />
                    {areaLabel}
                  </h2>
                  <div id={gridId} className="gw-areas" role="group" aria-label={copy.subtopics.topicsOf(areaLabel)}>
                    {shown.map(([id, sub], index) => {
                      const pressed = selectedTopics.has(id);
                      return (
                        <Toggle
                          key={id}
                          variant="outline"
                          className="gw-area"
                          pressed={pressed}
                          onPressedChange={() => toggleTopic(id)}
                          style={{ '--area-accent': area.gradient, '--i': index }}
                        >
                          <span className="gw-area-icon" aria-hidden="true">
                            <area.icon size={20} weight={pressed ? 'fill' : 'regular'} />
                          </span>
                          <span className="gw-area-name">{sub.label}</span>
                          <span className="gw-area-box" aria-hidden="true">
                            <Check size={11} weight="bold" />
                          </span>
                        </Toggle>
                      );
                    })}
                  </div>
                  {folds && (hidden > 0 || expanded) && (
                    <button
                      type="button"
                      className="gw-more"
                      aria-expanded={expanded}
                      aria-controls={gridId}
                      onClick={() => toggleExpanded(key)}
                    >
                      {expanded ? copy.subtopics.showLess : copy.subtopics.showMore(hidden)}
                      <CaretDown size={14} weight="bold" aria-hidden="true" className={expanded ? 'is-flipped' : undefined} />
                    </button>
                  )}
                </section>
              );
            })}
          </motion.section>
        </AnimatePresence>
      </div>

      <footer className="gw-foot">
        {/* The dots on every screen, the areas' too: a running count of what
            is picked used to sit here, and each tile already says whether it
            is on (`aria-pressed`), to the eye and to a screen reader. */}
        <ol className="gw-dots" aria-label={copy.progress}>
            {STEPS.map((name, index) => (
              <li
                key={name}
                className={`gw-dot${index === stepIndex ? ' is-active' : ''}${index < stepIndex ? ' is-done' : ''}`}
                aria-current={index === stepIndex ? 'step' : undefined}
              >
                <span className="gw-dot-label">{copy.stepOf(index + 1, STEPS.length)}</span>
              </li>
            ))}
        </ol>

        {/* The way forward and the two quiet ways round it, in one row: back
            where there is somewhere to go back to, the skip to the question
            wherever there is intro left. Bare icons, named for assistive tech
            and in a tooltip; each keeps its slot when absent, so the button
            never moves between screens. */}
        <div className="gw-actions">
          <span className="gw-action-slot">
            {stepIndex > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="gw-icon-action"
                onClick={() => goTo(stepIndex - 1)}
                aria-label={copy.back}
                title={copy.back}
              >
                <ArrowLeft size={20} aria-hidden="true" />
              </Button>
            )}
          </span>

          <Button size="lg" onClick={primary} disabled={primaryDisabled} className="gw-primary">
            {stepCopy.cta}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>

          <span className="gw-action-slot">
            {stepIndex < TOPICS_INDEX && (
              <Button
                variant="ghost"
                size="icon"
                className="gw-icon-action"
                onClick={() => goTo(TOPICS_INDEX)}
                aria-label={copy.skip}
                title={copy.skip}
              >
                <SkipForward size={20} aria-hidden="true" />
              </Button>
            )}
          </span>
        </div>
      </footer>
    </motion.main>
  );
}
