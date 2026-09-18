/**
 * PaperTok landing — motion
 *
 * An ES module, not the IIFE a from-scratch script would default to: task
 * 10 arms the hero deck under the same reduced-motion/viewport gate as the
 * pile below, and imports `shouldAnimate` from here rather than duplicating
 * it. A module already scopes everything declared in it, so nothing here
 * needs a wrapping closure to stay off `window`.
 *
 * Nothing in this file is load-bearing for reading: the landing is
 * prerendered, so every word of it is in the HTML whether or not this runs.
 */

/**
 * Whether this visit gets any of it. Four gates, all of which have to hold:
 * the APIs this file needs, no stated preference against motion, and a
 * screen wide enough with a pointer precise enough that the motion is
 * something to look at rather than something in the way.
 *
 * index.html mirrors this exact check inline, before the first paint, so
 * whatever is hidden by a start state is hidden before it ever paints — see
 * `data-motion` there. Failing closed is the safe side: no attribute, no
 * motion, nothing hidden.
 */
export function shouldAnimate() {
  if (!('IntersectionObserver' in window)) return false;
  if (!window.matchMedia) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  /* Width AND pointer: the ration was written for a reader with a mouse and
     a tall window. On a phone the same motion is either invisible — the
     section is taller than the screen — or in the way. */
  return window.matchMedia('(min-width: 768px) and (hover: hover) and (pointer: fine)').matches;
}

/* ── The rewrite levels ──────────────────────────────────────────────────
   Armed unconditionally, ahead of the motion gate: a tap works on a phone,
   under reduced motion, and with every arrival switched off — the tabs are
   how a reader picks what to read, not a piece of motion.

   The three tabs ship `disabled` in the prerendered markup (page.js): with
   no JavaScript there is no click handler and no keydown handler behind
   them, so an ENABLED button that does nothing on press is exactly the dead
   control this page may not leave anyone with. Enabling them here, the
   moment a click handler actually exists to answer them, is the same rule
   armRewrite already applies to these same buttons while the sequence
   streams (`tab.disabled = phase !== 'done'`) — this just covers the other
   half of the button's life, before armLevels has run at all. */
export function armLevels(root) {
  var tabs = [].slice.call(root.querySelectorAll('.lp-levels__tab'));
  var panels = [].slice.call(root.querySelectorAll('.lp-panel__level'));
  if (!tabs.length) return;

  function select(index) {
    root.style.setProperty('--lp-level', String(index));
    tabs.forEach(function (tab, i) {
      tab.setAttribute('aria-selected', i === index ? 'true' : 'false');
      tab.setAttribute('tabindex', i === index ? '0' : '-1');
    });
    panels.forEach(function (panel, i) {
      panel.setAttribute('data-active', i === index ? 'true' : 'false');
    });
  }

  tabs.forEach(function (tab, i) {
    tab.disabled = false;
    tab.addEventListener('click', function () { select(i); });
    /* A tab strip is one stop in the tab order; the arrows move within it —
       WAI-ARIA's roving-tabindex pattern. preventDefault here has nothing
       to do with the page's scroll: it stops the arrow key's own default
       (which, in some hosts, scrolls the page) so the key can move focus
       between tabs instead. See wheel.test.js for why the file-wide
       preventDefault ban was narrowed to make room for exactly this. */
    tab.addEventListener('keydown', function (event) {
      var next = event.key === 'ArrowRight' ? i + 1 : event.key === 'ArrowLeft' ? i - 1 : -1;
      if (next < 0 || next >= tabs.length) return;
      event.preventDefault();
      select(next);
      tabs[next].focus();
    });
  });

  var initial = tabs.findIndex(function (t) { return t.getAttribute('aria-selected') === 'true'; });
  select(initial < 0 ? 0 : initial);
}

/* ── The rewrite, as a sequence ──────────────────────────────────────────
   The markup rests on the finished passage, which is what anyone without
   JavaScript reads. This turns it into the sequence the section is about:
   the paper and its button first, then the two labels of the wait, then the
   text writing itself.

   The timings are the DEMO's, not the product's — a real rewrite takes
   between ten seconds and a minute, and a landing page gets about three.
   The labels, their order and every animation are the app's.

   IT ONLY RUNS WHEN SOMEBODY PRESSES. The section does not play itself: a
   page that performs its own demo while you are reading it is talking over
   you, and the whole point of the button is that pressing it is the thing
   being shown. What the page does instead is ASK — see the invitation in
   motion.css, which is why that breath matters more than it looks.

   And it never goes back. Nothing un-rewrites a paper in the product. */
var REWRITE_STEPS = [
  ['press', 0], ['source', 140], ['reading', 1640], ['done', 3340],
];
var REWRITE_WRITE_MS = 1500;   /* how long the wipe's one-shot stays armed */

export function armRewrite(root) {
  var card = root.querySelector('[data-rewrite-card]');
  var ghost = root.querySelector('[data-rewrite-ghost]');
  var reader = root.querySelector('[data-rewrite-reader]');
  var button = root.querySelector('[data-rewrite-start]');
  var tabs = [].slice.call(root.querySelectorAll('.lp-levels__tab'));
  if (!card || !ghost || !reader || !button) return;

  var timers = [];
  var started = false;

  function at(ms, fn) { timers.push(window.setTimeout(fn, ms)); }

  function flag(el, name, on) {
    if (on) el.setAttribute(name, ''); else el.removeAttribute(name);
  }

  function setPhase(phase) {
    root.setAttribute('data-phase', phase);
    var open = phase !== 'idle' && phase !== 'press';
    flag(root, 'data-open', open);
    flag(root, 'data-busy', phase === 'source' || phase === 'reading');
    /* Four controls a keyboard reaches and cannot see: the button once the
       sheet is over it, and the three tabs while there is nothing to choose
       between. The reader disables the other levels while it streams
       (PaperReader.jsx), which is the same rule. */
    button.disabled = open;
    card.inert = open;
    reader.inert = !open;
    tabs.forEach(function (tab) { tab.disabled = phase !== 'done'; });
  }

  function start() {
    if (started) return;
    started = true;
    timers.forEach(window.clearTimeout);
    timers = [];
    REWRITE_STEPS.forEach(function (step) {
      at(step[1], function () { setPhase(step[0]); });
    });
    at(3340, function () { root.setAttribute('data-write', ''); });
    at(3340 + REWRITE_WRITE_MS, function () { root.removeAttribute('data-write'); });
  }

  /* The card only exists once this has run: the prerendered page ships the
     reader, and nothing here may leave a visitor with a button that does
     nothing. armRewrite runs only behind the same gate as the rest of the
     page's motion (see init() below), so a visit that never reaches this
     point never has a card to begin with — only the reader, at rest. */
  card.hidden = false;
  ghost.hidden = false;
  setPhase('idle');
  root.setAttribute('data-found', '0');

  button.addEventListener('click', start);

  /* Found: the invitation does not come back for the rest of the visit —
     and it LEAVES rather than being cut off.

     Stopping a CSS animation drops its property to the underlying value in
     a single frame, so a button caught mid-swell snapped from 1.05 to 1 the
     instant the pointer arrived. The way out is to hand the swell to the
     transition: freeze it where it is with an inline value, stop the rule,
     and release the inline value on the next frame — that last step is a
     computed-value change, which is the only thing a transition answers to.
     (Which is also why :hover must NOT stop the animation in CSS: by the
     time this runs, :hover is already applied, and there would be nothing
     left to read.) */
  function found() {
    if (root.getAttribute('data-found') === '1') return;
    var mid = window.getComputedStyle(button).scale;
    if (mid && mid !== 'none') button.style.scale = mid;
    root.setAttribute('data-found', '1');
    window.requestAnimationFrame(function () { button.style.scale = ''; });
  }

  ['mouseenter', 'focus'].forEach(function (type) {
    button.addEventListener(type, found);
  });

  /* The sheet grows out of the button's rectangle — the app reads it with
     getBoundingClientRect (setReaderOrigin in PaperCard.jsx) and so does
     this, once the card has been laid out. Guarded: a zero-width rect means
     the section is still off-screen, and the default origin is fine. */
  var box = root.getBoundingClientRect();
  var rect = button.getBoundingClientRect();
  if (rect.width) {
    root.style.setProperty('--lp-origin-x', Math.round(rect.left - box.left + rect.width / 2) + 'px');
    root.style.setProperty('--lp-origin-y', Math.round(box.bottom - (rect.top + rect.height / 2)) + 'px');
  }

  /* The invitation may only start once the screen is HERE. This is four
     sections down the page: armed at load, the button would have breathed
     its five breaths into an empty room and be silent by the time anyone
     arrived. The observer does nothing else — there is no automatic press. */
  var watch = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      watch.unobserve(entry.target);
      root.setAttribute('data-seen', '1');
    });
  }, { threshold: 0.5 });
  watch.observe(root);
}

/* ── The pile's picker wheel ─────────────────────────────────────────────
   Driven frame by frame from here rather than as a CSS arrival, for two
   reasons a stylesheet cannot meet: it has to ADD to whatever velocity the
   wheel already has when flicked twice in a row, which no keyframe running
   from a fixed `from` to a fixed `to` can express; and there is no event to
   hang a CSS transition on in the first place — a rewritten `textContent`
   does not transition.

   The geometry is WHEEL in papers.js, repeated here because page.js writes
   the same numbers into the prerendered markup and landing.css builds the
   cylinder from them — the three have to agree exactly. A step here that
   disagreed with the radius there would not throw, it would just bend
   wrong. */
var WHEEL_SLOTS = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
var WHEEL_STEP = 9;       /* degrees between slots */
/* The flick is stated as an IMPULSE and a coast, not as a distance and a
   duration, because that is the only way a second flick can add to the
   first instead of replacing it.

   REACH is how far one flick projects — Apple's own projection, distance =
   velocity x time constant — and it has to be COPRIME WITH PILE.length (25;
   see papers.js) or the wheel cycles back to papers it has already shown.
   TAU is the coast: a scroll view's decelerationRate d, per millisecond, is
   tau = d / (1000(1 - d)), so 380ms is d = 0.99738, just inside the 0.998
   iOS ships for scrolling — a long coast, because the whole character here
   is a fast leave that keeps dying away rather than a short throw.

   Three reaches, not one, and never the same twice running: a hand does not
   deal the same flick twice, and a wheel that travels exactly the same
   distance every time is the least alive thing about it — you notice the
   repeat before you notice the motion. */
var WHEEL_REACHES = [14, 16, 18];                 /* rows one flick projects */
var WHEEL_TAU = 380;                              /* ms, the coast's time constant */
/* The floor of sight: below this the spin has nothing left to show. The
   spin ends when it drops under it, so a harder flick coasts LONGER, which a
   fixed duration could not express. */
var WHEEL_STOP_V = 0.46;
var WHEEL_MAX_V = 18 / (WHEEL_TAU / 1000) * 1.15;

/**
 * Builds the driver for one pile, or returns null if its markup or its data
 * script is absent.
 *
 * The barrel holds thirteen SLOTS and the papers move through them, so the
 * arc never has to grow past ±54° however long PILE gets. Everything below
 * follows from that: `pos` is which paper is on the line, as a continuous
 * number; the slots are relabelled when its whole-row part changes, and the
 * barrel itself only ever turns the fraction in between.
 *
 * The ceiling on how fast this may honestly go is not the frame rate, it is
 * how fast TEXT may cross the window: a row that advances more than about
 * 0.8 of its own height between two frames shows sharp, unrelated text on
 * consecutive frames with nothing in between, and the eye reads that as
 * flicker rather than as speed — aliasing of the movement, not of the
 * rendering, so no frame-rate measurement sees it. Measured on this wheel:
 * 1.42 rows per frame flickers, 0.81 does not. Three ways past that ceiling
 * were built and thrown away — sharp and fast (the measurement above), a
 * Gaussian smear (reads as OUT OF FOCUS, not as moving — keeps a bright
 * legible core), fading the rows (reads as grey text, edges still sharp, so
 * the strobe is dimmed rather than gone) — all three found by LOOKING at
 * the frames, the only instrument that sees any of this. So the reaches and
 * TAU above stand as measured; what buys the character instead is the
 * COAST being long: fast at the top, never degraded, never in a hurry to
 * stop.
 */
export function makeWheel(frame) {
  var barrel = frame.querySelector('.lp-pile__barrel');
  var data = document.getElementById('lp-pile-data');
  if (!barrel || !data) return null;

  var papers;
  try { papers = JSON.parse(data.textContent); } catch { return null; }
  if (!papers || papers.length <= WHEEL_SLOTS.length) return null;

  var slots = [].slice.call(barrel.children);
  if (slots.length !== WHEEL_SLOTS.length) return null;

  /* Accumulates, and that is the point: the wheel never returns to where it
     was, so coming back up to this card finds the pile somewhere new. */
  var pos = 0;
  var painted = null;    /* which paper the labels currently show on the line */
  var raf = 0;

  function paint(next) {
    var base = Math.floor(next);
    /* The barrel turns only the fraction between one slot and the next. On
       reaching a whole slot the labels shift by one and the rotation returns
       to zero — geometrically identical, so the seam is invisible and the
       wheel can roll for ever. */
    barrel.style.rotate = 'x ' + (-(next - base) * WHEEL_STEP).toFixed(3) + 'deg';
    /* Between detents only the angle moves. Rewriting twenty-six text nodes
       every frame to set them to what they already say is the kind of work
       that turns a smooth spin into a stuttering one. */
    if (base === painted) return;
    painted = base;
    for (var s = 0; s < slots.length; s++) {
      var i = ((base + WHEEL_SLOTS[s]) % papers.length + papers.length) % papers.length;
      slots[s].children[0].textContent = papers[i][0];
      slots[s].children[1].textContent = papers[i][1];
    }
  }

  /* The running coast, or null. Kept so a second flick can ask it how fast
     the wheel is going right now. */
  var spin = null;
  /* Which reach the last flick used, so the next one picks a different one:
     drawing freely at random would repeat, and a repeat is the whole thing
     being avoided. Seeded at random too, or the first flick of every visit
     is the same one and the first flick is the one most people see. */
  var lastReach = Math.floor(Math.random() * WHEEL_REACHES.length);

  /* rAF hands its callback a performance.now() timestamp, so the flick has
     to read the same clock or `elapsed` is a number from a different
     universe and the first frame lands past the end. Tested for rather than
     called, because performance.now() is 0 at the very first tick of the
     page and a falsy test would quietly fall through to Date.now(). Where
     it is missing the spin adopts the first callback's timestamp instead
     and simply gives up the frame this was meant to save. */
  var clock = (window.performance && typeof window.performance.now === 'function')
    ? function () { return window.performance.now(); }
    : null;

  function velocityAt(now) {
    if (!spin) return 0;
    /* Started but not yet painted: it is going at exactly what it was
       given. */
    var el = spin.t0 === null ? 0 : now - spin.t0;
    if (el >= spin.ms) return 0;
    /* d/dt of  from + span(1 - e^(-t/TAU)) / norm, in rows per second. */
    return (spin.span / (WHEEL_TAU / 1000) / spin.norm) * Math.exp(-el / WHEEL_TAU);
  }

  return function flick() {
    var now = clock ? clock() : 0;

    /* A flick ADDS to whatever the wheel is already doing. This is the one
       thing a fixed distance-and-duration could not express: retargeting
       from the current position but at full speed again drops or jumps the
       velocity at the seam. A real wheel shoved twice goes faster and
       further, and so does this one. */
    var reach = WHEEL_REACHES[(lastReach + 1 + Math.floor(Math.random() * (WHEEL_REACHES.length - 1))) % WHEEL_REACHES.length];
    lastReach = WHEEL_REACHES.indexOf(reach);
    var v0 = Math.min(velocityAt(now) + reach / (WHEEL_TAU / 1000), WHEEL_MAX_V);
    var from = pos;
    /* Project where that velocity would carry it, then land on the detent
       nearest THAT — the wheel has to come to rest with a row on the line,
       and a picker that stops between detents is not a picker. Rounding
       moves the landing by at most half a row, which is under 2% of the
       reach: the flick you feel is the one you gave it. */
    var to = Math.round(from + v0 * (WHEEL_TAU / 1000));
    var span = to - from;
    if (span <= 0) return;
    /* A harder flick takes longer to fall under the floor of sight. */
    var ms = WHEEL_TAU * Math.log(v0 / WHEEL_STOP_V);
    var norm = 1 - Math.exp(-ms / WHEEL_TAU);

    if (raf) window.cancelAnimationFrame(raf);
    /* Timed from the flick and not from the first callback: with t0 set in
       the callback the first painted frame is still at the start position,
       which is a whole frame of nothing at the moment the eye is looking
       hardest. */
    spin = { from: from, span: span, t0: clock ? now : null, ms: ms, norm: norm };
    /* On the thing whose pixels actually change, and only while they are
       changing. A barrel left promoted costs memory the page never gets
       back. */
    barrel.style.willChange = 'rotate';

    raf = window.requestAnimationFrame(function step(at) {
      if (spin.t0 === null) spin.t0 = at;
      var el = at - spin.t0;
      var done = el >= spin.ms;
      pos = done ? spin.from + spin.span
        : spin.from + spin.span * (1 - Math.exp(-el / WHEEL_TAU)) / spin.norm;
      paint(pos);
      if (!done) {
        raf = window.requestAnimationFrame(step);
        return;
      }
      raf = 0;
      spin = null;
      pos = Math.round(pos);   /* exactly on the detent, not 17.9999 of the way */
      paint(pos);
      barrel.style.willChange = '';
    });
  };
}

/* The wheel turns once when its frame comes into view — half of it, which
   on a phone-tall laptop is the moment it is being looked at — and again
   whenever it is clicked. Nothing here listens to the scroll: the page
   scrolls, the wheel watches. */
export function armPile() {
  var frame = document.querySelector('.lp-pile');
  if (!frame) return;
  var flick = makeWheel(frame);
  if (!flick) return;
  var seen = false;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting || seen) return;
      seen = true;
      flick();
      io.disconnect();
    });
  }, { threshold: 0.5 });
  io.observe(frame);
  frame.addEventListener('click', function () { flick(); });
}

/* Exported so a test can call it directly with the page's real globals
   substituted, and prove `shouldAnimate()` actually gates `armPile()`
   rather than trusting that the two are wired together correctly by
   reading the source — see wheel.test.js. */
export function init() {
  /* Unconditional, and ahead of the gate below: the tabs are how a reader
     picks a reading level, not a piece of motion, so they have to work on a
     phone, under reduced motion, and with data-motion never set — see
     armLevels' own comment. `[data-levels]` and `[data-rewrite]` are the
     same element in this page's markup (`.lp-rewrite`), so one query below
     serves armRewrite too. */
  var rewrite = document.querySelector('[data-levels]');
  if (rewrite) armLevels(rewrite);

  if (document.documentElement.getAttribute('data-motion') !== 'on' || !shouldAnimate()) return;
  armPile();
  if (rewrite) armRewrite(rewrite);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
