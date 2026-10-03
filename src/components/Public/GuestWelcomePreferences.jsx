import { useEffect, useState } from 'react';
import { animate, cubicBezier, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from 'framer-motion';
import { ArrowUpRight, BookOpen, Check, Cursor, FileText, Flask, Folder, GithubLogo, GraduationCap, LockSimple, Star } from '@phosphor-icons/react';
import { CATEGORIES } from '../../data/categories.js';
import { Button } from '../ui/button.jsx';
import { Switch } from '../ui/switch.jsx';

const LEVELS = [
  { id: 'beginner', title: 'Beginner', icon: BookOpen, description: 'Everyday language. Ideas explained from scratch.' },
  { id: 'university', title: 'University', icon: GraduationCap, description: 'Core concepts, context, and the science behind them.' },
  { id: 'researcher', title: 'Researcher', icon: Flask, description: 'Technical depth, methods, and nuance. Clearly structured.' },
];

export function WelcomeReadingChoice({ level, onChange }) {
  return <div className="gw-preferences">
    <fieldset className="gw-levels">
      <legend className="visually-hidden">Default plain words reading level</legend>
      {LEVELS.map(option => <label className="gw-level" key={option.id}>
        <input type="radio" name="welcome-reading-level" value={option.id} checked={level === option.id} onChange={() => onChange(option.id)}/>
        <option.icon size={24} aria-hidden="true"/>
        <strong>{option.title}</strong>
        <span>{option.description}</span>
      </label>)}
    </fieldset>
    <p className="gw-preference-note">With a free account, supported papers with full text can be read in plain words. You can change the level for any paper.</p>
  </div>;
}

// The letter that comes out of the envelope is a real paper, cited as it was
// published (the same one drifts past the welcome's first screen). The two
// behind it are unnamed: only their fields' colours show.
const DIGEST_LETTER = {
  field: 'physics',
  title: 'Observation of Gravitational Waves from a Binary Black Hole Merger',
  authors: 'LIGO Scientific and Virgo Collaborations',
  venue: 'Phys. Rev. Lett.',
  year: 2016,
  hook: 'Two black holes merged 1.3 billion light-years away, and for the first time we heard it.',
};
const DIGEST_BEHIND = [
  { key: 'bio', accent: CATEGORIES.bio.gradient, settle: 'translateY(30px) rotate(-6deg)' },
  { key: 'cs', accent: CATEGORIES.cs.gradient, settle: 'translateY(22px) rotate(5deg)' },
];
// Where the spark burst's dots fly, from the top of the landed letter.
const DIGEST_SPARKS = [
  { x: -78, y: -22, accent: CATEGORIES.physics.gradient },
  { x: -52, y: -48, accent: CATEGORIES.cs.gradient },
  { x: -16, y: -62, accent: CATEGORIES.bio.gradient },
  { x: 20, y: -60, accent: CATEGORIES.math.gradient },
  { x: 56, y: -44, accent: CATEGORIES.med.gradient },
  { x: 80, y: -18, accent: CATEGORIES.econ.gradient },
];

// The beat entrance's curve for what arrives; a strong ease-in-out for the
// flap, which moves on screen rather than entering.
const ARRIVE_EASE = [0.16, 1, 0.3, 1];
const FLAP_EASE = [0.77, 0, 0.175, 1];
const SEAL_AT = 0.6;
const FLAP_AT = 0.75;
const FLAP_DURATION = 0.55;
const LETTERS_AT = FLAP_AT + FLAP_DURATION - 0.05;
const SPARKS_AT = LETTERS_AT + 0.55;

// The digest arriving: a sealed envelope lands, the seal gives, the flap
// swings open and a paper rises out of it with two more behind. Plays once
// and is still by about 2.5 seconds (WCAG 2.2.2). With motion refused it is
// drawn open, the letter already out.
function DigestPreview({ still, subscribed }) {
  const field = CATEGORIES[DIGEST_LETTER.field];
  const rise = { type: 'spring', duration: 0.8, bounce: 0.22 };
  return <div className="gw-digest-preview" aria-hidden="true">
    <motion.div
      className="gw-env"
      initial={still ? false : { opacity: 0, transform: 'translateY(16px)' }}
      animate={{ opacity: 1, transform: 'translateY(0px)' }}
      transition={{ duration: 0.45, ease: ARRIVE_EASE, delay: 0.1 }}
    >
      <div className="gw-env-back"/>
      <motion.div
        className="gw-env-flap"
        style={{ zIndex: still ? 1 : 4 }}
        initial={still ? false : { transform: 'rotateX(0deg)' }}
        animate={{ transform: 'rotateX(180deg)', ...(still ? {} : { transitionEnd: { zIndex: 1 } }) }}
        transition={{ duration: FLAP_DURATION, ease: FLAP_EASE, delay: FLAP_AT }}
      >
        <svg viewBox="0 0 240 150" preserveAspectRatio="none"><path d="M0 0.5 L120 93 L240 0.5"/></svg>
      </motion.div>
      <div className="gw-env-slot">
        {DIGEST_BEHIND.map((letter, index) => <motion.div
          key={letter.key}
          className="gw-env-letter gw-env-letter--behind"
          style={{ '--area-accent': letter.accent }}
          initial={still ? false : { transform: 'translateY(220px) rotate(0deg)' }}
          animate={{ transform: letter.settle }}
          transition={{ ...rise, delay: LETTERS_AT + index * 0.08 }}
        >
          <span className="gw-demo-title"/>
          <span className="gw-demo-title gw-demo-title--short"/>
        </motion.div>)}
        <motion.div
          className="gw-env-letter"
          style={{ '--area-accent': field.gradient }}
          initial={still ? false : { transform: 'translateY(220px)' }}
          animate={{ transform: 'translateY(0px)' }}
          transition={{ ...rise, delay: LETTERS_AT + 0.16 }}
        >
          <strong lang="en">{DIGEST_LETTER.title}</strong>
          <span className="gw-env-authors">{DIGEST_LETTER.authors}</span>
          <span className="gw-env-hook">{DIGEST_LETTER.hook}</span>
          <span className="gw-env-venue">{DIGEST_LETTER.venue}</span>
        </motion.div>
      </div>
      <div className="gw-env-pocket">
        <svg viewBox="0 0 240 150" preserveAspectRatio="none"><path d="M0.5 0.5 L120 87 L239.5 0.5 M0.5 149.5 L98 76 M239.5 149.5 L142 76"/></svg>
        {/* Turning the digest on readdresses the envelope: the two lines
            share a cell and cross-fade, so a quick on-off-on retargets. */}
        <span className="gw-env-label" data-subscribed={subscribed ? '' : undefined}>
          <span>PaperTok digest · Today</span>
          <span><Check size={11} weight="bold"/>On its way to you</span>
        </span>
      </div>
      {!still && <motion.span
        className="gw-env-seal"
        initial={{ opacity: 1, transform: 'translateX(-50%) scale(1)' }}
        animate={{ opacity: 0, transform: 'translateX(-50%) scale(0.9)' }}
        transition={{ duration: 0.2, ease: ARRIVE_EASE, delay: SEAL_AT }}
      >P</motion.span>}
      {!still && <div className="gw-env-sparks">
        {DIGEST_SPARKS.map(spark => <motion.span
          key={`${spark.x}:${spark.y}`}
          style={{ '--area-accent': spark.accent }}
          initial={{ opacity: 0, transform: 'translate(0px, 0px) scale(1)' }}
          animate={{
            opacity: [0, 1, 0],
            transform: ['translate(0px, 0px) scale(1)', `translate(${spark.x * 0.7}px, ${spark.y * 0.7}px) scale(1)`, `translate(${spark.x}px, ${spark.y}px) scale(0.6)`],
          }}
          transition={{ duration: 0.65, ease: ARRIVE_EASE, times: [0, 0.35, 1], delay: SPARKS_AT }}
        />)}
      </div>}
    </motion.div>
  </div>;
}

// The digest is opt-in: off until the visitor turns it on. A yes travels with
// the other answers and is saved on the account at onboarding; the
// subscription itself starts with the account's first follow, because the
// digest is built from follows (EmailNotificationsContext).
export function WelcomeInboxChoice({ subscribed, onChange }) {
  const still = Boolean(useReducedMotion());
  return <div className="gw-preferences gw-inbox">
    <DigestPreview still={still} subscribed={subscribed}/>
    <label className="gw-digest-optin" data-checked={subscribed ? '' : undefined}>
      <span className="gw-digest-optin-text">
        <strong id="gw-digest-optin-title">Email me the daily digest</strong>
        <span id="gw-digest-optin-desc">Starts with your first follow. Unsubscribe anytime.</span>
      </span>
      <Switch
        className="data-checked:border-[var(--accent-success)] data-checked:bg-[var(--accent-success)]"
        checked={subscribed}
        onCheckedChange={checked => onChange(Boolean(checked))}
        aria-labelledby="gw-digest-optin-title"
        aria-describedby="gw-digest-optin-desc"
      />
    </label>
  </div>;
}

// The repository's real top-level entries (AGENTS.md's project map); the rest
// of the page is skeleton, and no star count is shown because none is known.
const REPO_ENTRIES = [
  { name: 'src', icon: Folder },
  { name: 'worker', icon: Folder },
  { name: 'public', icon: Folder },
  { name: 'docs', icon: Folder },
  { name: 'README.md', icon: FileText },
];

// The star demo's clock, in seconds: the cursor crosses to the Star button,
// the page zooms into that corner, the click lands, and the page zooms back.
// One motion value runs the whole of it, so the star can only turn when the
// cursor's press does, however late a frame arrives.
const STAR_TOTAL = 4;
const STAR_CLICK_AT = 2.45;
const starTimes = (...seconds) => seconds.map(second => second / STAR_TOTAL);
const MOVE_EASE = cubicBezier(...FLAP_EASE);
const hold = value => value;
const CURSOR_REST = { x: 96, y: 138 };
const CURSOR_ON_STAR = { x: 310, y: 23 };
const CURSOR_TIMES = starTimes(0, 0.65, 1.55, STAR_TOTAL);
const CURSOR_EASE = [hold, MOVE_EASE, hold];

// A browser on the repository, starring it: plays once and is still by four
// seconds (WCAG 2.2.2). An illustration only — nothing here stars the real
// repository; the button under it opens GitHub. With motion refused it is
// drawn starred, at rest, without the cursor.
function StarDemo({ still }) {
  const [starred, setStarred] = useState(still);
  const clock = useMotionValue(still ? 1 : 0);
  useEffect(() => {
    if (still) return undefined;
    const controls = animate(clock, 1, { duration: STAR_TOTAL, ease: 'linear' });
    return () => controls.stop();
  }, [clock, still]);
  useMotionValueEvent(clock, 'change', (value) => {
    if (value >= STAR_CLICK_AT / STAR_TOTAL) setStarred(true);
  });
  const zoom = useTransform(clock, starTimes(0, 1.5, 2.15, 3.3, 3.95, STAR_TOTAL), [1, 1, 2, 2, 1, 1], { ease: [hold, MOVE_EASE, hold, MOVE_EASE, hold] });
  const pageTransform = useTransform(zoom, value => `scale(${value})`);
  const cursorX = useTransform(clock, CURSOR_TIMES, [CURSOR_REST.x, CURSOR_REST.x, CURSOR_ON_STAR.x, CURSOR_ON_STAR.x], { ease: CURSOR_EASE });
  const cursorY = useTransform(clock, CURSOR_TIMES, [CURSOR_REST.y, CURSOR_REST.y, CURSOR_ON_STAR.y, CURSOR_ON_STAR.y], { ease: CURSOR_EASE });
  const cursorPress = useTransform(clock, starTimes(0, 2.35, STAR_CLICK_AT, 2.6, STAR_TOTAL), [1, 1, 0.8, 1, 1]);
  const cursorTransform = useTransform([cursorX, cursorY, cursorPress], ([x, y, press]) => `translate(${x}px, ${y}px) scale(${press})`);
  const cursorOpacity = useTransform(clock, starTimes(0, 0.3, 0.5, 3.3, 3.7, STAR_TOTAL), [0, 0, 1, 1, 0, 0]);
  return <motion.div
    className="gw-gh"
    aria-hidden="true"
    initial={still ? false : { opacity: 0, transform: 'translateY(14px)' }}
    animate={{ opacity: 1, transform: 'translateY(0px)' }}
    transition={{ duration: 0.45, ease: ARRIVE_EASE, delay: 0.1 }}
  >
    <div className="gw-gh-chrome">
      <span className="gw-gh-dots"><i/><i/><i/></span>
      <span className="gw-gh-url"><LockSimple size={9} weight="fill"/>github.com/mugar123/papertok</span>
    </div>
    <div className="gw-gh-view">
      <motion.div className="gw-gh-page" style={{ transform: pageTransform }}>
        <div className="gw-gh-head">
          <GithubLogo size={14} weight="fill"/>
          <span className="gw-gh-repo">mugar123 / <strong>papertok</strong></span>
          <span className="gw-gh-pill">Public</span>
          <span className="gw-gh-star" data-starred={starred ? '' : undefined}>
            <motion.span
              key={starred ? 'on' : 'off'}
              className="gw-gh-star-icon"
              initial={still || !starred ? false : { transform: 'scale(0.6)' }}
              animate={{ transform: 'scale(1)' }}
              transition={{ type: 'spring', duration: 0.5, bounce: 0.45 }}
            >
              <Star size={11} weight={starred ? 'fill' : 'regular'}/>
            </motion.span>
            {starred ? 'Starred' : 'Star'}
            {starred && !still && <>
              <motion.span
                className="gw-gh-ring"
                initial={{ opacity: 0.6, transform: 'scale(1)' }}
                animate={{ opacity: 0, transform: 'scale(1.5)' }}
                transition={{ duration: 0.6, ease: ARRIVE_EASE }}
              />
              <motion.span
                className="gw-gh-plus"
                initial={{ opacity: 0, transform: 'translateY(0px)' }}
                animate={{ opacity: [0, 1, 0], transform: 'translateY(-16px)' }}
                transition={{ duration: 0.8, ease: ARRIVE_EASE, times: [0, 0.25, 1] }}
              >+1</motion.span>
            </>}
          </span>
        </div>
        <div className="gw-gh-tabs"><span className="is-active">Code</span><span>Issues</span><span>Pull requests</span></div>
        <ul className="gw-gh-files">
          {REPO_ENTRIES.map(entry => <li key={entry.name}>
            <entry.icon size={11} weight={entry.icon === Folder ? 'fill' : 'regular'}/>
            <span>{entry.name}</span>
            <i/>
          </li>)}
        </ul>
        {!still && <motion.span className="gw-gh-cursor" style={{ opacity: cursorOpacity, transform: cursorTransform }}>
          <Cursor size={15} weight="fill"/>
        </motion.span>}
      </motion.div>
    </div>
  </motion.div>;
}

export function WelcomeProjectSupport() {
  const still = Boolean(useReducedMotion());
  return <div className="gw-preferences gw-support">
    <StarDemo still={still}/>
    <div className="gw-support-copy">
      <p>More stars bring more contributors, and that means a better feed for you.</p>
      <Button variant="outline" size="lg" render={<a href="https://github.com/mugar123/papertok" target="_blank" rel="noopener noreferrer"/>}><Star size={19} aria-hidden="true"/>Star on GitHub<ArrowUpRight size={16} aria-hidden="true"/><span className="visually-hidden"> (opens in a new tab)</span></Button>
    </div>
  </div>;
}
