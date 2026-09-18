import { HERO_PAPERS, REPO, SOURCES, PEOPLE, PILE, WHEEL, SIGNALS, LEVELS, DEFAULT_LEVEL, REWRITE } from './papers.js';

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `esc()` is for text nodes and quoted attribute VALUES; it does nothing for
 * a value that becomes part of a bare identifier — a class name spliced into
 * a class list (`lp-chip--${tone}`) or a token spliced into `var(...)`
 * (`var(${accent})`). A space there still opens a second class; a `)` or `;`
 * there still escapes the `var()` call and starts writing arbitrary CSS.
 * `esc()` would leave both untouched, so this checks the SHAPE instead and
 * throws rather than emit either — this module only ever runs at prerender
 * (vite.config.js's `transformIndexHtml`), never in the browser, so failing
 * loudly here fails the BUILD, not a page already in front of a reader.
 * Exported only so page.test.js can prove it throws; paper()/chip()'s own
 * documented interface is unchanged by this.
 */
export function assertSafeToken(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`);
  return value;
}

/* lucide's paths, byte for byte, so the landing's marks are the app's. */
const ICON_PATHS = {
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  sparkles: '<path class="lp-spark lp-spark--star" d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><g class="lp-spark lp-spark--cross"><path d="M20 2v4"/><path d="M22 4h-4"/></g><circle class="lp-spark lp-spark--dot" cx="4" cy="20" r="2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  graph: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  person: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  octocat: null,
};
/* `ICON_PATHS[name]` silently stringifies to "undefined" (a typo'd name) or
   "null" (`octocat`, a real placeholder task 9 fills in) as inert text
   inside the <svg> — invisible, since a bare text node outside <text> does
   not render, so nothing would ever say why an icon is blank. Loud instead:
   both a missing name and an unfilled one throw at prerender time. */
const icon = (name, size = 16) => {
  const path = ICON_PATHS[name];
  if (path == null) throw new Error(`icon(): no path for "${name}"`);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
};

const chip = ({ label, tone }) => `<span class="lp-chip lp-chip--${assertSafeToken(tone, /^[a-z]+$/, 'chip tone')}">${esc(label)}</span>`;
const chips = (list = []) => list.length ? `<div class="lp-chips">${list.map(chip).join('')}</div>` : '';
const dot = '<span class="lp-paper__dot" aria-hidden="true">·</span>';
/* `--i` is the stacking index PaperCard.css itself uses (`.pc-author-avatar`):
   `margin-left: calc(var(--i, 0) * -7px)` overlaps avatar N under avatar
   N-1 without ever pulling the LAST one into the byline's own gap, and
   `z-index: calc(3 - var(--i, 0))` keeps the first avatar on top — the same
   two facts a flat `margin-right: -7px` on every avatar got backwards. */
const avatars = (initials = []) => initials.length ? `<span class="lp-avatars" aria-hidden="true">${initials.map((i, idx) => `<span class="lp-avatar" style="--i: ${idx}">${esc(i)}</span>`).join('')}</span>` : '';

/* The band on paper; the rule on ink (see landing.css) — same class, the
   theme decides. `hlRule()` does not exist: the dark/close form is a CSS
   selector's job ([data-theme="dark"] .lp-hl, .lp-close .lp-hl), not a
   second JS helper making the same call twice. Author-written literal text
   ONLY — `hl()` does not escape, so a paper title or any other data-derived
   string must never pass through it. */
const hl = (text) => `<span class="lp-hl">${text}</span>`;

/**
 * A paper, set the way PaperCard sets it. `heading` is the level of its
 * title: h2 inside the hero (the sheet is the section's content) and h3
 * inside a section that already has an h2. `tags` is part of this helper's
 * documented interface for a later task and unused until then.
 */
// eslint-disable-next-line no-unused-vars -- `tags` is documented above; task 6-9 code fills it in.
function paper(p, { size = 'md', heading = 'h3', tags = false } = {}) {
  const accent = assertSafeToken(p.fieldVar || '--gradient-physics', /^--[a-z0-9-]+$/, 'accent token');
  return `<article class="lp-paper lp-paper--${size}" style="--lp-accent: var(${accent})">
    <span class="lp-paper__accent" aria-hidden="true"></span>
    <p class="lp-paper__meta"><span class="lp-paper__field">${esc(p.field)}</span>${p.category ? `${dot}<span>${esc(p.category)}</span>` : ''}${dot}<span>${esc(p.year)}</span></p>
    ${chips(p.chips)}
    <${heading} class="lp-paper__title">${esc(p.title)}</${heading}>
    ${p.authors ? `<p class="lp-paper__authors">${avatars(p.initials)}<span class="lp-paper__author-names">${esc(p.authors)}</span></p>` : ''}
    ${p.abstract ? `<p class="lp-paper__abstract">${esc(p.abstract)}</p>` : ''}
    <div class="lp-paper__actions" aria-hidden="true">
      <span class="lp-btn lp-btn--md">${icon('file')}Read article</span>
      <span class="lp-btn lp-btn--md lp-btn--ai">${icon('sparkles')}Read in plain words</span>
      <span class="lp-paper__spacer"></span>
      <span class="lp-iconbtn">${icon('share')}</span><span class="lp-iconbtn lp-iconbtn--graph">${icon('graph')}</span>
    </div>
  </article>`;
}

const skip = () => `<a class="lp-skip" href="#main-content">Skip to content</a>`;

const bar = () => `<header class="lp-bar lp-bar--yellow">
  <a class="lp-wordmark" href="/" aria-label="PaperTok">Paper<span>Tok</span></a>
  <nav class="lp-bar__right" aria-label="Site">
    <a class="lp-bar__link" href="https://github.com/${esc(REPO.path)}">Source</a>
    <a class="lp-btn" href="/feed">Open the feed</a>
  </nav>
</header>`;

/* The hero. Nothing arrives: the page is prerendered. The sheet is a deck the
   reader passes with Skip (the app's own action) or the arrow keys once
   motion.js arms it (task 10) — until then slides 2 and 3 ship `hidden` as
   well as `aria-hidden="true" inert`, and the foot (Skip + count) ships
   `hidden` too, so a visit with no JavaScript is one readable paper and
   nothing a keyboard can reach and not see, not a three-tall stack waiting
   on a script that has not run. WAI-ARIA carousel: group + roledescription,
   one slide visible at a time — plain `<div>`s, not an `<ol>`/`<li>`: each
   slide's own `role="group"` already overrides whatever `<li>` would have
   told assistive tech (an item with a role replacing "listitem" is no
   longer counted as one, so the list would report itself as having zero
   items), so a semantic list here never bought anything real. */
const hero = () => `<section class="lp-hero" aria-labelledby="lp-h1">
  <div class="lp-wrap lp-hero__grid">
    <div class="lp-hero__claim">
      <h1 id="lp-h1" class="lp-h1">Research you weren't looking for.</h1>
      <p class="lp-lede">A feed of scientific papers from open, public sources. Scroll it the way you scroll anything else.</p>
      <p class="lp-hero__cta"><a class="lp-btn lp-btn--lg" href="/feed">Open the feed</a><span class="lp-hero__note">No account needed to look.</span></p>
    </div>
    <div class="lp-sheet" data-deck tabindex="0" role="group" aria-roledescription="carousel" aria-label="Three papers from the feed">
      <div class="lp-deck">
        <div class="lp-deck__reel" data-deck-reel>
          ${HERO_PAPERS.map((p, i) => `<div class="lp-hero__slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${HERO_PAPERS.length}"${i ? ' hidden aria-hidden="true" inert' : ''}>${paper(p, { size: 'sheet', heading: 'h2' })}</div>`).join('\n')}
        </div>
      </div>
      <div class="lp-deck__foot" hidden>
        <button class="lp-deck__skip" type="button" data-deck-skip hidden aria-label="Skip to the next paper">${icon('ban', 15)}Skip</button>
        <span class="lp-deck__count" data-deck-count aria-live="polite">1 / ${HERO_PAPERS.length}</span>
      </div>
    </div>
  </div>
</section>`;

/**
 * The pile, as a picker wheel.
 *
 * What is written here is THIRTEEN SLOTS, not twenty-five papers — the barrel
 * holds the slots and the papers move through them, which is how a wheel of
 * thirteen cells shows a list of any length without its arc ever growing past
 * the point where rows fold back on themselves (WHEEL in papers.js has the
 * full geometry, and why thirteen and not nine).
 *
 * The slots are prerendered holding the papers they show at rest, so a
 * visitor with no JavaScript gets a real, readable list of real papers rather
 * than an empty frame; the driver in motion.js then rewrites those same
 * spans as it turns.
 *
 * `aria-hidden`: decorative, not content. Thirteen slots cycling through
 * twenty-five papers, some of them mid-turn, is not a list a screen reader
 * could make sense of — and once motion.js takes over, the labels keep
 * changing under it with no live region announcing any of it. The real
 * list — all twenty-five, once, in reading order — is the plain
 * `<ul class="lp-visually-hidden">` problem() places right beside this.
 */
const pile = () => `<div class="lp-pile" aria-hidden="true">
  <ol class="lp-pile__barrel">
    ${WHEEL.SLOTS.map((k) => {
      /* At rest pos is 0, so slot k shows the paper k places along, wrapped —
         exactly what the driver's own indexing produces on its first paint,
         so nothing jumps the moment the script takes over. */
      const row = PILE[((k % PILE.length) + PILE.length) % PILE.length];
      return `<li class="lp-pile__slot" style="--k: ${k}">`
        + `<span class="lp-pile__venue">${esc(row.venue)}</span>`
        + `<span class="lp-pile__title">${esc(row.title)}</span>`
        + `</li>`;
    }).join('\n    ')}
  </ol>
</div>`;

/**
 * The pile's full list, shipped once as data at the very end of the
 * document — past `</main>` and the footer, outside every layout rule that
 * could reach a stray child and give it a `display` the browser's own
 * `script { display: none }` would otherwise have won (the same fight
 * `.lp-deck__foot[hidden]` has to win explicitly above, for the same
 * reason: an author rule beats the user agent's regardless of specificity).
 *
 * A visitor with no JavaScript already has everything this page draws from
 * PILE — paper() and pile() rendered it. This script exists for motion.js,
 * which reads the JSON actually sitting in the page rather than importing
 * PILE a second time, so the wheel can never turn up a paper the markup
 * did not.
 */
const pileData = () => `<script type="application/json" id="lp-pile-data">${
  JSON.stringify(PILE.map((row) => [row.venue, row.title])).replace(/</g, '\\u003c')
}</script>`;

const problem = () => `<section class="lp-problem lp-sec" aria-labelledby="lp-problem-h">
  <div class="lp-wrap lp-cols lp-cols--centre">
    <div class="lp-head">
      <h2 id="lp-problem-h" class="lp-h2">Search works when you already know what you're looking for.</h2>
      <p class="lp-body">Most of the research worth reading is ${hl("the research you didn't know to search for")}. A field next to yours. A method you've never used. A question you didn't know was still open.</p>
      <p class="lp-body">More is published every day than anyone can get through, and none of it arrives unless you ask for it by name. There was no good way to run into any of it, so I built one.</p>
    </div>
    <div class="lp-pile-wrap">
      ${pile()}
      <ul class="lp-visually-hidden" id="lp-pile-list">${PILE.map((r) => `<li>${esc(r.title)} (${esc(r.venue)})</li>`).join('')}</ul>
    </div>
  </div>
</section>`;

const signals = () => `<section class="lp-signals lp-sec" aria-labelledby="lp-signals-h">
  <div class="lp-wrap lp-cols">
    <div class="lp-head">
      <h2 id="lp-signals-h" class="lp-h2">One paper at a time.</h2>
      <p class="lp-body">A paper arrives full screen. Skip it, save it, or open it, and the next one gets closer to what you care about. It is not trying to find the most popular paper. It is trying to leave room for the unexpected.</p>
    </div>
    <ul class="lp-signals__grid">${SIGNALS.map(([name, what]) => `<li class="lp-signal"><span class="lp-signal__name">${esc(name)}</span><span class="lp-signal__what">${esc(what)}</span></li>`).join('')}</ul>
  </div>
</section>`;

/**
 * The rewrite, as a sequence the reader triggers.
 *
 * The markup rests on the finished passage — that is what the prerender is
 * for, and what a visitor without JavaScript, on a phone, or asking for less
 * motion reads: `.lp-rewrite__reader` ships live, with its tabs already
 * wired to real `<button>`s (armLevels runs before the motion gate, so the
 * tabs work even when nothing animates). The card and the loading skeleton
 * ship `hidden`; armRewrite (motion.js) is what turns the button into a
 * sequence, and it only runs behind the same gate as the rest of the page's
 * motion — nobody may be left with a button that does nothing, so until that
 * gate opens there is no button to leave broken, only the reader.
 *
 * The one highlight in this section: the brief's own sentence — "felt the
 * same tiny stretch of space at the same moment" — is Beginner-level
 * phrasing and does not appear in LEVELS[DEFAULT_LEVEL] (University), which
 * is where the page actually opens. The University paragraph's own sentence
 * carrying the same beat — two places, one signal, the same moment — is
 * "Two detectors 3,000 km apart recorded the same brief signal within
 * milliseconds of each other.", so that is what `hl()` wraps here instead of
 * inventing a sentence that was never reviewed as part of the paragraph.
 */
const plainWords = () => `<section class="lp-reader lp-sec" aria-labelledby="lp-reader-h">
  <div class="lp-wrap lp-cols">
    <div class="lp-head">
      <h2 class="lp-h2" id="lp-reader-h">Read it in plain words.</h2>
      <p class="lp-body">Any paper, rewritten at three levels. The abstract of a paper outside your field stops being a wall.</p>
      <p class="lp-body">Select a passage and you can highlight it, write a note on it, or ask for that part alone. Everything collects in a rail beside the text, saved per paper.</p>
      <p class="lp-body">It works on the whole paper, not on the abstract: the PDF is fetched and read end to end, which is why the wait is a minute rather than a second. When the full text cannot be opened, it says so instead of rewriting the summary and calling it the paper.</p>
      <p class="lp-body">What comes out is yours to keep — a <code class="lp-code">.tex</code> that compiles as it is, or a PDF, with your highlights and your notes numbered at the foot. The title, the authors, the link to the original and the line saying a model wrote it travel on every copy.</p>
    </div>

    <div class="lp-rewrite" data-rewrite data-levels>
      <div class="lp-rewrite__card" data-rewrite-card hidden>
        ${paper(REWRITE.paper, { size: 'lg' })}
        <div class="lp-rewrite__actions">
          <button class="lp-btn lp-btn--ai lp-btn--lg" type="button" data-rewrite-start aria-label="Read this paper in plain words">
            ${icon('sparkles', 20)}<span>Read in plain words</span>
          </button>
          <span class="lp-eyebrow">${esc(REWRITE.cost)}</span>
        </div>
      </div>

      <div class="lp-rewrite__reader" data-rewrite-reader>
        <p class="lp-rewrite__status">
          <span class="lp-eyebrow lp-rewrite__kicker">${icon('sparkles', 11)}Read in plain words</span>
          <span class="lp-uses">
            <span class="lp-uses__meter" aria-hidden="true">${Array.from({ length: REWRITE.uses.total }, (_, i) => `<i class="lp-uses__seg"${i === REWRITE.uses.total - 1 ? ' data-spent' : ''}></i>`).join('')}</span>
            <span>${REWRITE.uses.left}/${REWRITE.uses.total} today</span>
          </span>
        </p>

        <div class="lp-levels-frame">
          <div class="lp-levels" role="tablist" aria-label="Rewrite level">
            ${LEVELS.map((l, i) => `<button class="lp-levels__tab" type="button" role="tab" id="lp-level-tab-${i}" aria-controls="lp-level-panel-${i}" aria-selected="${i === DEFAULT_LEVEL}" tabindex="${i === DEFAULT_LEVEL ? '0' : '-1'}">${esc(l.name)}</button>`).join('')}
          </div>
        </div>

        <div class="lp-panel">
          <div class="lp-ghost" data-rewrite-ghost hidden>
            <p class="lp-ghost__head" role="status" aria-live="polite">
              <span class="lp-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              ${REWRITE.stages.map((st) => `<span class="lp-ghost__stage lp-eyebrow" data-rewrite-stage="${esc(st.id)}">${esc(st.label)}</span>`).join('')}
              <small>${esc(REWRITE.hint)}</small>
            </p>
            <div class="lp-ghost__body" aria-hidden="true">
              <div class="lp-ghost__title"></div>
              <div class="lp-ghost__lines">${REWRITE.ghostLines.map((w, i) => `<i class="lp-ghost__line" style="--lp-w: ${w}; --lp-i: ${i}"></i>`).join('')}</div>
            </div>
          </div>

          <div class="lp-doc">
            <h3 class="lp-doc__title">${esc(REWRITE.heading)}</h3>
            <div class="lp-doc__levels">
              ${LEVELS.map((l, i) => `<div class="lp-panel__level" id="lp-level-panel-${i}" role="tabpanel" aria-labelledby="lp-level-tab-${i}" data-active="${i === DEFAULT_LEVEL}">${l.paras.map((para, j) => `<p style="--lp-i: ${j}">${
                i === DEFAULT_LEVEL && j === 0
                  ? esc(para).replace('Two detectors 3,000 km apart recorded the same brief signal within milliseconds of each other.', hl('Two detectors 3,000 km apart recorded the same brief signal within milliseconds of each other.'))
                  : esc(para)
              }</p>`).join('')}</div>`).join('')}
            </div>
            <aside class="lp-note" aria-label="Your note">
              <span class="lp-note__kicker">Your note</span>
              <p>Why 200,000 years? That's the false-alarm rate — ask the model.</p>
            </aside>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>`;

const LABEL_ROWS = [
  [{ label: 'Verified', tone: 'blue' }, "Passed peer review, according to the record."],
  [{ label: 'Preprint', tone: 'amber' }, 'Posted before review. Read it as such.'],
  [{ label: 'Open access', tone: 'green' }, 'You can read the whole thing right now.'],
  [{ label: 'Open version', tone: 'green' }, 'The journal charges; a free copy exists elsewhere.'],
  [{ label: 'Subscription', tone: 'amber' }, "Only the abstract is free. It says so before you click."],
];

/** Five honest-label chips, the app's own — each with the one sentence that
 * says what it actually means, so a reader never has to guess what a chip
 * is claiming. No motion: this is reference material, read once and kept. */
const labels = () => `<section class="lp-labels lp-sec" aria-labelledby="lp-labels-h">
  <div class="lp-wrap lp-cols">
    <div class="lp-head">
      <h2 id="lp-labels-h" class="lp-h2">Every card says what it is.</h2>
      <p class="lp-body">Whether it passed peer review, and whether you can actually read it. When the record doesn't say, the card shows nothing rather than a guess.</p>
    </div>
    <dl class="lp-labels__list">${LABEL_ROWS.map(([c, why]) => `<div class="lp-labels__row"><dt>${chip(c)}</dt><dd>${esc(why)}</dd></div>`).join('')}</dl>
  </div>
</section>`;

const strip = () => `<section class="lp-strip" aria-labelledby="lp-strip-h">
  <h2 id="lp-strip-h" class="lp-visually-hidden">Where it comes from, and who makes it</h2>
  <div class="lp-wrap lp-strip__grid">
    <p>The papers come from <strong>${SOURCES.map(([n]) => esc(n)).join(', ').replace(/, ([^,]*)$/, ' and $1')}</strong>, with others filling in access links, funding and citations. PaperTok hosts nothing and is affiliated with none of them.</p>
    <p>The ranking is experimental, so it's readable: <a href="https://github.com/${esc(REPO.path)}">${esc(REPO.path)}</a>, ${esc(REPO.license)}. The weights, the worker and the argument behind every change are in the open.</p>
    <p>I started it in June 2026 as a physics student who kept missing the papers next door. <a href="https://github.com/${esc(PEOPLE[1].github)}">${esc(PEOPLE[1].name)}</a> joined in August and shaped how it looks.</p>
  </div>
</section>`;

const close = () => `<section class="lp-close" aria-labelledby="lp-close-h">
  <div class="lp-wrap lp-close__grid">
    <h2 id="lp-close-h" class="lp-close__line">Start with a paper ${hl("you didn't expect.")}</h2>
    <p class="lp-close__action"><a class="lp-btn lp-btn--lg lp-btn--yellow" href="/feed">Open the feed</a><span class="lp-close__note">No account needed to look.</span></p>
  </div>
</section>`;

const foot = () => `<footer class="lp-footer">
  <a class="lp-wordmark" href="/" aria-label="PaperTok">Paper<span>Tok</span></a>
  <span class="lp-footer__links"><a href="https://github.com/${esc(REPO.path)}">GitHub</a><a href="/privacy.html">Privacy</a><span>Español and English</span><span>Version 0.2</span></span>
</footer>`;

export function buildLandingHtml() {
  const screens = [hero(), problem(), signals(), plainWords(), labels(), strip(), close()]; // tasks 8–9 insert their sections before strip()
  return `${skip()}\n${bar()}\n<main id="main-content" class="lp-main">\n${screens.join('\n')}\n</main>\n${foot()}\n${pileData()}`;
}
