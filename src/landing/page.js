import { HERO_PAPERS, REPO, SOURCES, PEOPLE } from './papers.js';

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;

const chip = ({ label, tone }) => `<span class="lp-chip lp-chip--${tone}">${esc(label)}</span>`;
const chips = (list = []) => list.length ? `<div class="lp-chips">${list.map(chip).join('')}</div>` : '';
const dot = '<span class="lp-paper__dot" aria-hidden="true">·</span>';
const avatars = (initials = []) => initials.length ? `<span class="lp-avatars" aria-hidden="true">${initials.map((i) => `<span class="lp-avatar">${esc(i)}</span>`).join('')}</span>` : '';

/* The band on paper; the rule on ink (see landing.css) — same class, the
   theme decides. */
const hl = (text) => `<span class="lp-hl">${text}</span>`;

/**
 * A paper, set the way PaperCard sets it. `heading` is the level of its
 * title: h2 inside the hero (the sheet is the section's content) and h3
 * inside a section that already has an h2. `tags` is part of this helper's
 * documented interface for a later task and unused until then.
 */
// eslint-disable-next-line no-unused-vars -- `tags` is documented above; task 6-9 code fills it in.
function paper(p, { size = 'md', heading = 'h3', tags = false } = {}) {
  const accent = p.fieldVar || '--gradient-physics';
  return `<article class="lp-paper lp-paper--${size}" style="--lp-accent: var(${accent})">
    <span class="lp-paper__accent" aria-hidden="true"></span>
    <p class="lp-paper__meta"><span class="lp-paper__field">${esc(p.field)}</span>${p.category ? `${dot}<span>${esc(p.category)}</span>` : ''}${dot}<span>${esc(p.year)}</span></p>
    ${chips(p.chips)}
    <${heading} class="lp-paper__title">${esc(p.title)}</${heading}>
    ${p.authors ? `<p class="lp-paper__authors">${avatars(p.initials)}<span>${esc(p.authors)}</span></p>` : ''}
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
   one slide visible at a time. */
const hero = () => `<section class="lp-hero" aria-labelledby="lp-h1">
  <div class="lp-wrap lp-hero__grid">
    <div class="lp-hero__claim">
      <h1 id="lp-h1" class="lp-h1">Research you weren't looking for.</h1>
      <p class="lp-lede">A feed of scientific papers from open, public sources. Scroll it the way you scroll anything else.</p>
      <p class="lp-hero__cta"><a class="lp-btn lp-btn--lg" href="/feed">Open the feed</a><span class="lp-hero__note">No account needed to look.</span></p>
    </div>
    <div class="lp-sheet" data-deck tabindex="0" role="group" aria-roledescription="carousel" aria-label="Three papers from the feed">
      <div class="lp-deck">
        <ol class="lp-deck__reel" data-deck-reel>
          ${HERO_PAPERS.map((p, i) => `<li class="lp-hero__slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${HERO_PAPERS.length}"${i ? ' hidden aria-hidden="true" inert' : ''}>${paper(p, { size: 'sheet', heading: 'h2' })}</li>`).join('\n')}
        </ol>
      </div>
      <div class="lp-deck__foot" hidden>
        <button class="lp-deck__skip" type="button" data-deck-skip hidden aria-label="Skip to the next paper">${icon('ban', 15)}Skip</button>
        <span class="lp-deck__count" data-deck-count aria-live="polite">1 / ${HERO_PAPERS.length}</span>
      </div>
    </div>
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
  const screens = [hero(), strip(), close()]; // tasks 6–9 insert their sections before strip()
  return `${skip()}\n${bar()}\n<main id="main-content" class="lp-main">\n${screens.join('\n')}\n</main>\n${foot()}`;
}
