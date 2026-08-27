/**
 * Geometry for the citation map: where every neighbour of a paper sits on the
 * two axes the map draws.
 *
 * Vertical is time, in two bands with their own scale — what the paper cites
 * above the rule, what cites it below. A single continuous scale would squash
 * one half against the rule whenever the two ranges differ in size, which is
 * most of the time.
 *
 * Horizontal is citations, logarithmic. Citation counts follow a power law: on
 * a linear axis one heavily cited neighbour pins every other node against the
 * left margin and the axis stops saying anything.
 *
 * A node is placed only when both coordinates are known. A paper resolved from
 * OpenCitations metadata rather than OpenAlex arrives with `citationCountKnown:
 * false` and sometimes without a year, and an unknown count is not a count of
 * zero — placing it would be an invention. Those are counted in `omitted` and
 * belong to the list view, which shows everything.
 */

export const CITATION_MAP_GEOMETRY = {
  sidePadding: 26,
  bandPadding: 10,
  ruleGap: 26,
  minGap: 20,
  minRowHeight: 14,
  labelWidth: 104,
  flipMargin: 60,
  nodeDelayBase: 220,
  nodeDelayStep: 24,
  edgeDelayBase: 160,
  edgeDelayStep: 16,
  /** Decades of slack on each side of the real range, so nothing touches the margin. */
  domainPadding: 0.2,
  /** A neighbourhood that spans less than this reads as a single column without it. */
  minDomainSpan: 0.6,
};

const EMPTY_BANDS = {
  references: { top: 0, bottom: 0 },
  citations: { top: 0, bottom: 0 },
};

export function isMappableCitationPaper(paper) {
  if (!paper) return false;
  const year = Number(paper.year);
  return Number.isFinite(year) && year > 0 && Boolean(paper.citationCountKnown);
}

export function formatCitationTick(value) {
  if (value >= 1000000) return `${value / 1000000}M`;
  if (value >= 1000) return `${value / 1000}K`;
  return String(value);
}

function impactOf(paper) {
  return Math.max(1, Number(paper?.citationCount) || 0);
}

function sortKey(paper, index) {
  return String(paper?.id || paper?.doi || paper?.title || index);
}

function logDomain(papers, geometry) {
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

/**
 * Time decides where a node wants to be; the spreading pass decides where it
 * fits. Two passes in each direction settle it: pushing apart from the top can
 * overflow the band, compressing from the bottom can push the first node out
 * of it, and running both again resolves the pair. The order is never touched,
 * so a node that is older than another is always drawn above it.
 */
function spreadWithinBand(positions, spacing, minY, maxY) {
  const ys = positions.slice();
  if (!ys.length) return ys;

  for (let pass = 0; pass < 3; pass += 1) {
    ys[0] = Math.max(ys[0], minY);
    for (let index = 1; index < ys.length; index += 1) {
      ys[index] = Math.max(ys[index], ys[index - 1] + spacing);
    }
    ys[ys.length - 1] = Math.min(ys[ys.length - 1], maxY);
    for (let index = ys.length - 2; index >= 0; index -= 1) {
      ys[index] = Math.min(ys[index], ys[index + 1] - spacing);
    }
  }
  return ys.map(y => Math.min(Math.max(y, minY), maxY));
}

function placeBand(papers, relation, bounds, geometry, xOf, width) {
  if (!papers.length) return [];

  const ordered = papers
    .map((paper, index) => ({ paper, index }))
    .sort((a, b) => (Number(a.paper.year) - Number(b.paper.year))
      || sortKey(a.paper, a.index).localeCompare(sortKey(b.paper, b.index)));

  const bandHeight = Math.max(0, bounds.bottom - bounds.top);
  const spacing = Math.min(geometry.minGap, bandHeight / ordered.length);
  const rowHeight = Math.max(geometry.minRowHeight, spacing);
  const minY = bounds.top + rowHeight / 2;
  // A sheet short enough to leave the band thinner than one row would put the
  // bottom of the band above its top, and every node off the plot entirely.
  const maxY = Math.max(minY, bounds.bottom - rowHeight / 2);

  const years = ordered.map(entry => Number(entry.paper.year));
  const oldest = Math.min(...years);
  const span = Math.max(1, Math.max(...years) - oldest);
  const travel = Math.max(0, maxY - minY);
  const wanted = ordered.map(entry => minY + ((Number(entry.paper.year) - oldest) / span) * travel);
  const ys = spreadWithinBand(wanted, spacing, minY, maxY);

  const flipAt = width - geometry.labelWidth - geometry.flipMargin;
  return ordered.map((entry, index) => {
    const x = xOf(entry.paper);
    return {
      key: `${relation}:${entry.paper.doi || entry.paper.id || entry.index}`,
      paper: entry.paper,
      relation,
      x,
      y: ys[index],
      rowHeight,
      side: x > flipAt ? 'left' : 'right',
      delay: geometry.nodeDelayBase + index * geometry.nodeDelayStep,
      edgeDelay: geometry.edgeDelayBase + index * geometry.edgeDelayStep,
    };
  });
}

export function buildCitationMapLayout({
  width = 0,
  height = 0,
  center = null,
  references = [],
  citations = [],
  geometry = CITATION_MAP_GEOMETRY,
} = {}) {
  const ruleY = height / 2;
  const bands = height > 0
    ? {
      references: { top: geometry.bandPadding, bottom: ruleY - geometry.ruleGap },
      citations: { top: ruleY + geometry.ruleGap, bottom: height - geometry.bandPadding },
    }
    : EMPTY_BANDS;

  const mappableReferences = references.filter(isMappableCitationPaper);
  const mappableCitations = citations.filter(isMappableCitationPaper);
  const omitted = {
    references: references.length - mappableReferences.length,
    citations: citations.length - mappableCitations.length,
  };

  const centerImpactKnown = Boolean(center?.citationCountKnown);
  const scaled = [...mappableReferences, ...mappableCitations];
  if (centerImpactKnown) scaled.push(center);
  const { low, high } = logDomain(scaled, geometry);

  const plotWidth = Math.max(0, width - geometry.sidePadding * 2);
  const xForImpact = impact => {
    const fraction = (Math.log10(impact) - low) / (high - low);
    return geometry.sidePadding + Math.min(1, Math.max(0, fraction)) * plotWidth;
  };
  const xOf = paper => xForImpact(impactOf(paper));

  const ready = width > 0 && height > 0;
  const centerX = centerImpactKnown && ready
    ? xOf(center)
    : geometry.sidePadding + plotWidth / 2;

  const ticks = [];
  if (ready) {
    for (let exponent = Math.ceil(low); exponent <= Math.floor(high); exponent += 1) {
      const value = 10 ** exponent;
      ticks.push({ value, x: xForImpact(value), label: formatCitationTick(value) });
    }
  }

  const nodes = ready
    ? [
      ...placeBand(mappableReferences, 'reference', bands.references, geometry, xOf, width),
      ...placeBand(mappableCitations, 'citation', bands.citations, geometry, xOf, width),
    ]
    : [];

  return { ready, centerX, centerImpactKnown, ruleY, bands, ticks, nodes, omitted };
}
