import type { Paper } from '../models/Paper.ts';
type Geometry = typeof CITATION_MAP_GEOMETRY;
interface Box { left: number; right: number; top: number; bottom: number }
/**
 * Geometry for the citation map: where every neighbour of a paper sits.
 *
 * Horizontal is time: each paper stands at its year, so what the paper cites
 * gathers to the left of it and what cites it to the right, with the centre
 * paper's own year between them.
 *
 * Vertical is citations, logarithmic, with a labelled scale. Citation counts
 * follow a power law: on a linear axis one heavily cited neighbour pins every
 * other node to the floor and the axis stops saying anything.
 *
 * Both coordinates are data, so a node is never moved up or down to make
 * room. Two papers that want the same spot (same year, similar count) are
 * spread sideways within their own year; one that finds no free spot there is
 * left out. Every node is a 24px pointer target (WCAG 2.2 SC 2.5.8, Target
 * Size Minimum), and two targets never overlap.
 *
 * A node is placed only when both coordinates are known. A paper resolved
 * from OpenCitations metadata rather than OpenAlex arrives with
 * `citationCountKnown: false` and sometimes without a year, and an unknown
 * count is not a count of zero: placing it would be an invention. Both kinds
 * of leftover, unmappable and unfit, stay in the list view, which shows
 * everything the map fetched.
 */

export const CITATION_MAP_GEOMETRY = {
  /** Room on the left for the citation scale's labels. */
  scalePadding: 44,
  sidePadding: 26,
  topPadding: 14,
  bottomPadding: 14,
  /**
   * WCAG 2.2 SC 2.5.8 (Target Size Minimum) floor: every node is a 24px
   * square target, and no two targets share a pixel. A node that cannot get
   * a free square in its own year is omitted, never shrunk.
   */
  minGap: 24,
  labelWidth: 104,
  labelHeight: 14,
  flipMargin: 60,
  /** The centre's chip ("This paper · 2016"), its gap from the mark, and
      how near the right edge it moves to the mark's left. */
  chipWidth: 136,
  chipHeight: 14,
  chipGap: 16,
  chipFlipAt: 180,
  nodeDelayBase: 220,
  nodeDelayStep: 24,
  edgeDelayBase: 160,
  edgeDelayStep: 16,
  /** Decades of slack above and below the real range, so nothing touches the edge. */
  domainPadding: 0.2,
  /** A neighbourhood that spans less than this reads as a single row without it. */
  minDomainSpan: 0.6,
  /** Half a year of slack on each side, so the first and last year are not on the edge. */
  yearPadding: 0.5,
  minYearSpan: 4,
  /** Year labels stand at least this far apart. */
  minYearTickGap: 44,
};

export function isMappableCitationPaper(paper: Partial<Paper> | null | undefined) {
  if (!paper) return false;
  const year = Number(paper.year);
  return Number.isFinite(year) && year > 0 && Boolean(paper.citationCountKnown);
}

export function formatCitationTick(value: number) {
  if (value >= 1000000) return `${value / 1000000}M`;
  if (value >= 1000) return `${value / 1000}K`;
  return String(value);
}

function impactOf(paper: Partial<Paper> | null | undefined) {
  return Math.max(1, Number(paper?.citationCount) || 0);
}

function yearOf(paper: Partial<Paper> | null | undefined) {
  const year = Number(paper?.year);
  return Number.isFinite(year) && year > 0 ? year : null;
}

function logDomain(papers: Partial<Paper>[], geometry: Geometry) {
  const logs = papers.map(paper => Math.log10(impactOf(paper)));
  if (!logs.length) return { low: 0, high: geometry.minDomainSpan };

  let low = Math.min(...logs);
  let high = Math.max(...logs);
  if (high - low < geometry.minDomainSpan) {
    const missing = (geometry.minDomainSpan - (high - low)) / 2;
    low -= missing;
    high += missing;
  }
  return { low: low - geometry.domainPadding, high: high + geometry.domainPadding };
}

function yearDomain(years: number[], geometry: Geometry) {
  if (!years.length) return { first: 0, last: geometry.minYearSpan };
  let first = Math.min(...years);
  let last = Math.max(...years);
  if (last - first < geometry.minYearSpan) {
    const missing = (geometry.minYearSpan - (last - first)) / 2;
    first -= missing;
    last += missing;
  }
  return { first: first - geometry.yearPadding, last: last + geometry.yearPadding };
}

/**
 * Alternates the two neighbourhoods in the order the Worker ranked them (most
 * cited first for references, most recent first for citations), so a map
 * that runs out of room keeps the leading papers of both rather than all of
 * one and none of the other.
 */
function interleave<T>(references: T[], citations: T[]) {
  const order: Array<{ paper: T; relation: 'reference' | 'citation'; rank: number }> = [];
  for (let index = 0; index < Math.max(references.length, citations.length); index += 1) {
    if (index < references.length) order.push({ paper: references[index], relation: 'reference', rank: index });
    if (index < citations.length) order.push({ paper: citations[index], relation: 'citation', rank: index });
  }
  return order;
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function buildCitationMapLayout<T extends Partial<Paper>>({
  width = 0,
  height = 0,
  center = null,
  references = [],
  citations = [],
  geometry = CITATION_MAP_GEOMETRY,
}: { width?: number; height?: number; center?: T | null; references?: T[]; citations?: T[]; geometry?: Geometry } = {}) {
  const ready = width > 0 && height > 0;
  // Until the neighbourhood lands there is no scale, so the centre stands at
  // the middle of the plot; it then moves to where its own year and count put it.
  const midX = width / 2;
  const midY = height / 2;
  const plot = {
    left: geometry.scalePadding,
    right: Math.max(geometry.scalePadding, width - geometry.sidePadding),
    top: geometry.topPadding,
    bottom: Math.max(geometry.topPadding, height - geometry.bottomPadding),
  };

  const mappableReferences = references.filter(isMappableCitationPaper);
  const mappableCitations = citations.filter(isMappableCitationPaper);

  const centerImpactKnown = Boolean(center?.citationCountKnown);
  const centerYear = yearOf(center);
  const scaled = [...mappableReferences, ...mappableCitations];
  if (centerImpactKnown) scaled.push(center!);
  const { low, high } = logDomain(scaled, geometry);
  const years = scaled.map(yearOf).filter(Boolean) as number[];
  if (centerYear && !centerImpactKnown) years.push(centerYear);
  const { first, last } = yearDomain(years, geometry);

  // Each node is a 24px square. The scale starts half of one in from the
  // left and the top, where its labels are, so a star at the first year or
  // the top count stands inside the plot rather than on them. The right and
  // bottom keep their room: that is where recent papers crowd the centre.
  const half = geometry.minGap / 2;
  const plotWidth = Math.max(0, plot.right - plot.left - half);
  const plotHeight = Math.max(0, plot.bottom - plot.top - half);
  const xForYear = (year: number) => plot.left + half + ((year - first) / (last - first)) * plotWidth;
  const yForImpact = (impact: number) => {
    const fraction = Math.min(1, Math.max(0, (Math.log10(impact) - low) / (high - low)));
    return plot.bottom - fraction * plotHeight;
  };
  const pxPerYear = plotWidth / (last - first);

  const centerX = ready && centerYear ? xForYear(centerYear) : midX;
  const centerY = ready && centerImpactKnown ? yForImpact(impactOf(center)) : midY;

  const ticks = [];
  const yearTicks = [];
  if (ready) {
    // Powers of ten; a neighbourhood narrower than two of them gets the 2
    // and 5 steps between as well, so the scale always has more than one mark.
    const powers = [];
    for (let exponent = Math.ceil(low); exponent <= Math.floor(high); exponent += 1) powers.push(10 ** exponent);
    const values = powers.length >= 2 ? powers : [];
    if (!values.length) {
      for (let exponent = Math.floor(low); exponent <= Math.ceil(high); exponent += 1) {
        for (const step of [1, 2, 5]) {
          const value = step * 10 ** exponent;
          if (value >= 1 && Math.log10(value) >= low && Math.log10(value) <= high) values.push(value);
        }
      }
    }
    for (const value of values) ticks.push({ value, y: yForImpact(value), label: formatCitationTick(value) });
    const step = [1, 2, 5, 10, 20, 50].find(candidate => candidate * pxPerYear >= geometry.minYearTickGap) || 100;
    for (let year = Math.ceil(first / step) * step; year <= last; year += step) {
      yearTicks.push({ year, x: xForYear(year) });
    }
  }

  // The centre mark claims a square too.
  const square = (x: number, y: number) => ({ left: x - half, right: x + half, top: y - half, bottom: y + half });
  const taken = [square(centerX, centerY)];
  // Sideways only, and never past the middle of the gap to the next year.
  const maxShift = Math.max(0, pxPerYear / 2 - 1);
  const offsets = [0];
  for (let step = geometry.minGap; step <= maxShift; step += geometry.minGap) offsets.push(step, -step);

  const placed = [];
  if (ready) {
    for (const entry of interleave(mappableReferences, mappableCitations)) {
      const wantedX = xForYear(yearOf(entry.paper)!);
      const y = yForImpact(impactOf(entry.paper));
      const x = offsets
        .map(offset => wantedX + offset)
        .find(candidate => candidate - half >= 0 && candidate + half <= width
          && !taken.some(box => overlaps(box, square(candidate, y))));
      if (x === undefined) continue;
      taken.push(square(x, y));
      placed.push({ ...entry, x, y });
    }
  }

  // Labels go where they fit: on the preferred side (away from the right
  // edge), else the other, else none until the node is hovered or focused.
  // A label never covers another node's target or another label.
  const flipAt = width - geometry.labelWidth - geometry.flipMargin;
  // The centre's chip is placed first, so no star's label lands on it.
  const chipSide = centerX > width - geometry.chipFlipAt ? 'left' : 'right';
  const chipLeft = chipSide === 'right'
    ? centerX + geometry.chipGap
    : centerX - geometry.chipGap - geometry.chipWidth;
  const labels = [{
    left: chipLeft,
    right: chipLeft + geometry.chipWidth,
    top: centerY - geometry.chipHeight / 2,
    bottom: centerY + geometry.chipHeight / 2,
  }];
  const labelBox = (node: { x: number; y: number }, side: string) => {
    const top = node.y - geometry.labelHeight / 2;
    const bottom = node.y + geometry.labelHeight / 2;
    return side === 'right'
      ? { left: node.x + half, right: node.x + half + geometry.labelWidth, top, bottom }
      : { left: node.x - half - geometry.labelWidth, right: node.x - half, top, bottom };
  };
  const labelFits = (box: Box) => box.left >= 0 && box.right <= width
    && !taken.some(other => overlaps(other, box)) && !labels.some(other => overlaps(other, box));

  const counters = { reference: 0, citation: 0 };
  const nodes = placed.map((node) => {
    const preferred = node.x > flipAt ? 'left' : 'right';
    const other = preferred === 'right' ? 'left' : 'right';
    const side = [preferred, other].find(s => labelFits(labelBox(node, s)));
    if (side) labels.push(labelBox(node, side));
    // The stagger restarts for each relation, so a full map does not queue
    // twenty nodes behind each other.
    const index = counters[node.relation];
    counters[node.relation] += 1;
    return {
      key: `${node.relation}:${node.paper.doi || node.paper.id || node.rank}`,
      paper: node.paper,
      relation: node.relation,
      x: node.x,
      y: node.y,
      side: side ?? preferred,
      labelHidden: !side,
      delay: geometry.nodeDelayBase + index * geometry.nodeDelayStep,
      edgeDelay: geometry.edgeDelayBase + index * geometry.edgeDelayStep,
    };
  });

  return {
    ready,
    centerX,
    centerY,
    chipSide,
    plot,
    ticks,
    yearTicks,
    nodes,
  };
}

/**
 * The link nearest a press on the map, by distance to each straight line from
 * the centre to its star, or null when none is within `reach`. Links converge
 * on the centre and run a few pixels apart, so a hit area per line would hand
 * the press to whichever was drawn last.
 */
export function nearestCitationLink<N extends { key: string; x: number; y: number }>(
  nodes: N[],
  center: { x: number; y: number },
  point: { x: number; y: number },
  reach = 20,
) {
  let nearest: string | null = null;
  let best = reach;
  for (const node of nodes) {
    const dx = node.x - center.x;
    const dy = node.y - center.y;
    const length = dx * dx + dy * dy;
    const t = length ? Math.min(1, Math.max(0, ((point.x - center.x) * dx + (point.y - center.y) * dy) / length)) : 0;
    const distance = Math.hypot(point.x - (center.x + t * dx), point.y - (center.y + t * dy));
    if (distance <= best) {
      best = distance;
      nearest = node.key;
    }
  }
  return nearest;
}
