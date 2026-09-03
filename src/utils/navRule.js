/**
 * Where the navbar's yellow rule goes, as a transform the compositor can
 * animate on its own.
 *
 * The rule used to be a framer `layoutId` element: measured and tweened in
 * JavaScript, on the main thread, on every frame. That is the thread the tab
 * switch was busy on — mounting a feed of cards blocked it for ~200 ms at a
 * time (see utils/feedMountWindow.js) — so the rule slid, froze short of the
 * word, and slid again. A CSS `transition` on `transform` runs on the
 * compositor and keeps moving while the main thread is busy.
 *
 * One rule, absolutely positioned at the left of the links row, of a fixed
 * base width; the active link's label span is reached with a translate and a
 * horizontal scale. The base width keeps the scale near 1 so the rounded
 * ends of a 3px bar are not visibly stretched.
 */
export const RULE_BASE_WIDTH_PX = 80;

/**
 * @param {{ left: number, width: number }} link  the active link's box
 * @param {number} containerLeft                 the links row's left edge
 * @param {number} inset                         the link's horizontal padding (the rule's inset)
 * @param {number} [baseWidth]
 * @returns {string} a CSS transform, or '' when there is nothing to mark
 */
export function ruleTransform(link, containerLeft, inset, baseWidth = RULE_BASE_WIDTH_PX) {
  if (!link || !Number.isFinite(link.left) || !Number.isFinite(link.width)) return '';
  const pad = Math.max(0, Number(inset) || 0);
  const width = Math.max(0, link.width - pad * 2);
  if (width <= 0 || baseWidth <= 0) return '';
  const x = link.left - (Number(containerLeft) || 0) + pad;
  return `translateX(${round(x)}px) scaleX(${round(width / baseWidth, 4)})`;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
