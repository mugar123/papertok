/**
 * The forme: how the Research highlights are laid out on the page.
 *
 * A newspaper section front is irregular, but it is not arbitrary — the page
 * is divided into a fixed measure and every row closes on it. Here the measure
 * is six columns, and a row is only valid when its cells add up to all six, so
 * the grid varies from edition to edition without ever leaving a ragged hole
 * the way a masonry layout would.
 *
 * Two properties matter more than the shapes:
 *
 *  - **The plan is seeded by the edition, not by the render.** `Math.random()`
 *    would recompose the page on every state change — a filter chip, a trend
 *    re-rank, a re-mount — and the reader would watch the papers move for no
 *    reason. The seed is derived from the edition itself, so one edition always
 *    composes the same page and the next one composes a different page.
 *
 *  - **The grid does not depend on the figures.** Whether a paper has a figure
 *    is only known after a round trip to the worker, and half of them answer
 *    with nothing. If the spans depended on that answer, every late or empty
 *    result would reflow the whole section. So the seed alone fixes the row
 *    patterns and the spans; the figure decides only what happens *inside* a
 *    cell. A paper that asks for a plate and does not get one falls back to its
 *    text shape at exactly the same width.
 */

/** Every pattern totals six, which is what keeps the rows closed. */
const ROW_PATTERNS = [[6], [4, 2], [2, 4], [3, 3], [2, 2, 2]];

/**
 * Slot shapes. `plate` says the slot would like a figure; it still renders
 * without one, as the matching text shape at the same span.
 */
export const SLOT_KINDS = {
  opener: { plate: true, aspect: 'wide', title: 'xl', dek: 3, strip: false },
  strip: { plate: true, aspect: 'sq', title: 'lg', dek: 3, strip: true },
  block: { plate: true, aspect: 'wide16', title: 'lg', dek: 2, strip: false },
  portrait: { plate: true, aspect: 'tall', title: 'sm', dek: 0, strip: false },
  wide: { plate: false, aspect: null, title: 'xl', dek: 3, strip: false },
  column: { plate: false, aspect: null, title: 'md', dek: 4, strip: false },
  brief: { plate: false, aspect: null, title: 'sm', dek: 0, strip: false },
};

/**
 * FNV-1a over the edition's identity. Any stable hash would do; this one is
 * short, has no dependencies and spreads adjacent strings well, which matters
 * because consecutive editions differ by only a few characters.
 */
export function formeSeed(parts) {
  const text = (Array.isArray(parts) ? parts : [parts])
    .map(part => (part == null ? '' : String(part)))
    .join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, and stable across engines. */
function prng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Row patterns for `count` papers.
 *
 * Only patterns that fit the papers still unplaced are offered, so the last
 * row is never short and the caller never has to pad a cell to close it. A
 * pattern is not repeated back to back where there is any alternative — two
 * identical rows in a row are what makes a varied grid read as a table.
 */
export function planRows(count, random) {
  const rows = [];
  let placed = 0;
  let previous = '';

  while (placed < count) {
    const left = count - placed;
    let options = ROW_PATTERNS.filter(pattern => pattern.length <= left);
    // `left` is at least 1 here, and [6] is one cell, so this cannot be empty.
    const fresh = options.filter(pattern => pattern.join('-') !== previous);
    if (fresh.length > 0) options = fresh;

    const pattern = options[Math.floor(random() * options.length)];
    previous = pattern.join('-');
    rows.push(pattern);
    placed += pattern.length;
  }

  return rows;
}

/**
 * Which slot a cell takes.
 *
 * `wantsPlate` is the paper's own eligibility — for Research that is whether
 * the figure service will even ask, which it only does for arXiv papers.
 * `hasPlate` is whether a figure actually came back. A cell that wanted one
 * and did not get one keeps its width and drops to the text shape.
 */
export function slotFor({ span, wantsPlate, hasPlate, isLead, coin }) {
  if (span === 6) {
    if (!hasPlate) return 'wide';
    // The opener is the lead and only the lead, so the section opens once and
    // does not repeat the gesture halfway down.
    return isLead ? 'opener' : 'strip';
  }
  if (span === 4 || span === 3) return hasPlate ? 'block' : 'column';
  if (hasPlate) return 'portrait';
  // A narrow paper that asked for a plate and did not get one falls back to
  // text carrying the cell. Dropping it to a headline on its own would punish
  // the paper twice for an answer the worker never had.
  if (wantsPlate) return 'column';
  return coin < 0.42 ? 'brief' : 'column';
}

/**
 * Lays the highlights out.
 *
 * `papers` are placed in order — the ranking already decided which paper leads,
 * and the forme does not second-guess it. `hasFigure` is asked per paper and
 * may change between renders as figures resolve; only the cells' interiors move
 * when it does.
 *
 * Returns one entry per paper: its grid span, its position in the row, its slot
 * and the presentation that slot implies.
 */
export function planForme(papers, { seed = 0, wantsFigure = () => false, hasFigure = () => false } = {}) {
  const list = Array.isArray(papers) ? papers.filter(Boolean) : [];
  if (list.length === 0) return [];

  const random = prng(seed);
  const rows = planRows(list.length, random);

  const cells = [];
  let index = 0;

  rows.forEach((pattern, rowIndex) => {
    const rowStart = index;
    const rowSpans = pattern;
    // Read before the cells are dressed: a text-only cell needs to know it is
    // standing beside a plate before it decides how much standfirst to run.
    const rowHasPlate = rowSpans.some((_, position) => hasFigure(list[rowStart + position]));

    rowSpans.forEach((span, position) => {
      const paper = list[index];
      let kind = slotFor({
        span,
        wantsPlate: wantsFigure(paper),
        hasPlate: hasFigure(paper),
        isLead: rowIndex === 0,
        coin: random(),
      });
      // A headline on its own beside a plate leaves a hole under it, so the
      // brief gives way to a column for as long as it shares the row.
      if (rowHasPlate && kind === 'brief') kind = 'column';
      const shape = SLOT_KINDS[kind];

      cells.push({
        paper,
        kind,
        span,
        isRowStart: position === 0,
        isRowEnd: position === rowSpans.length - 1,
        plate: shape.plate,
        aspect: shape.aspect,
        // A wide cell carries a larger headline than a narrow one of the same
        // slot; the shape gives the default and the span raises it.
        titleSize: kind === 'column' && span >= 4 ? 'lg' : shape.title,
        // Beside a plate, a text cell runs its standfirst out to fill the row.
        dekLines: rowHasPlate && !shape.plate ? Math.max(shape.dek, 4) : shape.dek,
        // A full-width text cell sets its standfirst in two columns, under a
        // heavy rule that stands in for the plate it does not have.
        twoColumnDek: kind === 'wide',
        rule: kind === 'wide' || (kind === 'column' && span >= 4),
        strip: shape.strip,
      });

      index += 1;
    });
  });

  return cells;
}
