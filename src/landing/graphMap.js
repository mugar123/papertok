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
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function citationPlate(map, { compact = false } = {}) {
  const W = compact ? 360 : 1200, H = compact ? 380 : 520, R = compact ? 190 : 276;
  const CX = compact ? 40 : 220, GAP = 16, LABEL_W = compact ? 0 : 126;
  const perDecade = compact ? 75 : 220, x0 = compact ? 40 : 300;
  const lx = (c) => Math.min(compact ? 340 : 1150, x0 + Math.log10(Math.max(c, 1)) * perDecade);
  const ticks = compact ? [['1', 0], ['100', 2], ['10K', 4]] : [['1', 0], ['10', 1], ['100', 2], ['1K', 3], ['10K', 4]];
  const above = compact ? map.above.slice(0, 3) : map.above;
  const below = compact ? map.below.slice(0, 1) : map.below;
  const yScale = compact ? H / 520 : 1;
  const node = (n, filled) => `<line class="mp-spoke" style="--i: ${n.order}" pathLength="1" x1="${CX}" y1="${R}" x2="${lx(n.citations)}" y2="${n.y * yScale}" stroke="var(--border-subtle)" stroke-width="1"></line><circle class="mp-node" style="--i: ${n.order}" cx="${lx(n.citations)}" cy="${n.y * yScale}" r="6" fill="${filled ? 'var(--gradient-physics)' : 'var(--bg-primary)'}" stroke="var(--gradient-physics)" stroke-width="2"></circle>${compact ? '' : `<text class="mp-label" style="--i: ${n.order}" x="${lx(n.citations) - 12}" y="${n.y + 4}" text-anchor="end" font-family="${MONO}" font-size="12" fill="var(--text-primary)">${esc(n.name)}</text>`}`;
  const corner = (x, y, anchor, text) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${MONO}" font-size="11" letter-spacing="0.06em" fill="var(--text-secondary)">${text}</text>`;
  return `<svg class="lp-plate${compact ? ' lp-plate--compact' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="lp-map-title${compact ? '-compact' : ''}" xmlns="http://www.w3.org/2000/svg">
    <title id="lp-map-title${compact ? '-compact' : ''}">The citation map of the LIGO paper: five works it cites above the line, two that cite it below, placed by how many citations each received.</title>
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
