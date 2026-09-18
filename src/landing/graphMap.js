/**
 * The citation map as one SVG: what the paper cites above the rule, what
 * cites it below, citations received on a log axis. Built from frozen data
 * (papers.js MAP). Every node, spoke and label carries `--i`, its draw-on
 * order, so motion.css can stagger them without a script.
 *
 * `compact` is not the wide plate scaled down by CSS — it is a separately
 * composed SVG: three-of-five above and one-of-two below, no per-node
 * labels or corner captions (there is no room to set them legibly at phone
 * width), and a three-mark axis instead of five. landing.css swaps which of
 * the two is `display: block` by viewport width; both are always in the
 * markup, because the visually-hidden `<ul>` beside them (page.js) is the
 * one list that actually has to carry every neighbour for assistive tech —
 * neither plate is it, both are `role="img"` pictures of the same data.
 */
import { esc } from './esc.js';

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";


export function citationPlate(map, { compact = false } = {}) {
  const W = compact ? 360 : 1200, H = compact ? 380 : 520, R = compact ? 190 : 276;
  // The centre sits LEFT of where the axis starts, on both plates. It is an
  // anchor, not a reading: the paper's own citations are the one number this
  // picture does not plot. The compact plate used to put both at x=40, which
  // was invisible only while every neighbour below the line happened to have
  // thousands of citations — the moment one has none, as the newest paper
  // citing anything does, its node lands on the axis origin, in the centre's
  // own column, with the spoke between them hidden under the gridline. So
  // compact keeps the same relationship the wide plate has, scaled down.
  const CX = compact ? 16 : 220, GAP = 16, LABEL_W = compact ? 0 : 126;
  const perDecade = compact ? 68 : 220, x0 = compact ? 64 : 300;
  const lx = (c) => Math.min(compact ? 336 : 1150, x0 + Math.log10(Math.max(c, 1)) * perDecade);
  const ticks = compact ? [['1', 0], ['100', 2], ['10K', 4]] : [['1', 0], ['10', 1], ['100', 2], ['1K', 3], ['10K', 4]];
  const above = compact ? map.above.slice(0, 3) : map.above;
  const below = compact ? map.below.slice(0, 1) : map.below;
  const yScale = compact ? H / 520 : 1;
  /* The compact plate shipped its nodes bare, on the grounds that no label
     could be set legibly at phone width. Measured rather than assumed, that
     is only true of the full names: `Acernese '14 · Advanced Virgo` does not
     fit, `Acernese '14` does, at 13px, with 200 units of viewBox to spare.
     Four unlabelled dots say nothing to the reader the section is written
     for, so the short name goes in, on whichever side of the dot has room —
     a node near the axis origin has none to its left. */
  const label = (n) => {
    const x = lx(n.citations);
    const text = compact ? String(n.name).split(' · ')[0] : n.name;
    // Set to the left of its dot, which is what the five above the line do,
    // unless there is no room left of it. Measured, not guessed by which half
    // of the plate it sits in: IBM Plex Mono's advance is exactly 0.6em, and
    // a rule of thumb like `x > W / 2` would flip labels on the wide plate
    // that have 200 units of clear space to their left.
    const right = x - 12 - text.length * (compact ? 13 : 12) * 0.6 >= 0;
    return `<text class="mp-label" style="--i: ${n.order}" x="${right ? x - 12 : x + 12}" y="${n.y * yScale + 4}" text-anchor="${right ? 'end' : 'start'}" font-family="${MONO}" font-size="${compact ? 13 : 12}" fill="var(--text-primary)">${esc(text)}</text>`;
  };
  const node = (n, filled) => `<line class="mp-spoke" style="--i: ${n.order}" pathLength="1" x1="${CX}" y1="${R}" x2="${lx(n.citations)}" y2="${n.y * yScale}" stroke="var(--border-subtle)" stroke-width="1"></line><circle class="mp-node" style="--i: ${n.order}" cx="${lx(n.citations)}" cy="${n.y * yScale}" r="6" fill="${filled ? 'var(--gradient-physics)' : 'var(--bg-primary)'}" stroke="var(--gradient-physics)" stroke-width="2"></circle>${label(n)}`;
  const corner = (x, y, anchor, text) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${MONO}" font-size="11" letter-spacing="0.06em" fill="var(--text-secondary)">${text}</text>`;
  return `<svg class="lp-plate${compact ? ' lp-plate--compact' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="lp-map-title${compact ? '-compact' : ''}" xmlns="http://www.w3.org/2000/svg">
    <title id="lp-map-title${compact ? '-compact' : ''}">The citation map of the LIGO paper: ${above.length} works it cites above the line, ${below.length} that cite${below.length === 1 ? 's' : ''} it below, placed by how many citations each received.</title>
    ${ticks.map(([, d]) => `<line x1="${x0 + d * perDecade}" y1="36" x2="${x0 + d * perDecade}" y2="${H - 44}" stroke="var(--border-subtle)"></line>`).join('')}
    ${compact ? '' : corner(0, 24, 'start', 'BEFORE · WHAT IT CITES') + corner(W, 24, 'end', `${map.above.length} MOST CITED OF ${map.totals.cited}`)}
    <line class="mp-rule" x1="0" y1="${R}" x2="${Math.max(0, CX - 9 - GAP - LABEL_W - GAP)}" y2="${R}" stroke="var(--text-primary)" stroke-width="1.2"></line>
    <line class="mp-rule" x1="${CX + 9 + GAP}" y1="${R}" x2="${W}" y2="${R}" stroke="var(--text-primary)" stroke-width="1.2"></line>
    ${above.map((n) => node(n, false)).join('')}
    ${below.map((n) => node(n, true)).join('')}
    <circle class="mp-node mp-node--centre" style="--i: 0" cx="${CX}" cy="${R}" r="9" fill="var(--text-primary)"></circle>
    ${compact ? '' : `<text class="mp-label" style="--i: 0" x="${CX - 9 - GAP}" y="${R + 4}" text-anchor="end" font-family="${MONO}" font-size="12" font-weight="600" fill="var(--text-primary)">${esc(map.centre.label)}</text>`}
    ${compact ? '' : corner(0, H - 22, 'start', 'AFTER · WHAT CITES IT') + corner(W, H - 22, 'end', `${map.below.length} MOST RECENT OF ${map.totals.citing.toLocaleString('en-US')}`)}
    ${ticks.map(([label, d]) => `<text x="${x0 + d * perDecade}" y="${H - 4}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="var(--text-tertiary)" class="mp-tick">${label}</text>`).join('')}
    ${compact ? '' : `<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="var(--text-tertiary)">citations received, log scale</text>`}
  </svg>`;
}
