import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { getKatex, loadKatex } from '../../utils/katexLoader.js';
import { displayProse, katexSource } from '../../utils/latex.js';
import { buildHighlightPlan } from '../../utils/textHighlights.js';
import {
  hiddenWidth,
  inlineMathNeedsScroll,
  sliderKeyTarget,
  sliderThumbWidth,
  sliderValueText,
} from '../../utils/wideMath.js';

/**
 * One rendered formula, and the slider it grows when it is wider than the
 * column (see utils/wideMath.js for why the column cannot just overflow).
 *
 * The element carrying `data-math` and the offsets stays the formula itself —
 * it becomes the scroller — so selection anchoring and the highlight classes
 * see exactly what they saw before. The wrapper and the slider carry no
 * offsets and no text, so they are invisible to `anchorFromSelection`.
 *
 * The slider is a native range input: it is a keyboard route to the hidden
 * part (WCAG 2.1.1) without making every formula a tab stop, it is visible on
 * touch screens and macOS where the system scrollbar only shows mid-scroll,
 * and dragging the formula itself still scrolls it as usual.
 */
function MathRun({ Tag, display, html, ...rest }) {
  const scrollerRef = useRef(null);
  // Same object across renders: React re-assigns `innerHTML` for a new one,
  // and this component re-renders on every scroll step — a fresh object would
  // rebuild the formula and throw it back to its start mid-drag.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const [inlineWide, setInlineWide] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [position, setPosition] = useState(0);
  const [thumb, setThumb] = useState(0);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (!display) {
      const paragraph = scroller.closest('p') || scroller.parentElement?.parentElement;
      const bases = [...scroller.querySelectorAll('.katex-html > .base')]
        .map(node => node.getBoundingClientRect().width);
      setInlineWide(inlineMathNeedsScroll(bases, paragraph?.clientWidth ?? 0));
    }
    const nextHidden = hiddenWidth(scroller.scrollWidth, scroller.clientWidth);
    setHidden(nextHidden);
    setPosition(Math.min(scroller.scrollLeft, nextHidden));
    setThumb(sliderThumbWidth(scroller.clientWidth, scroller.clientWidth, scroller.scrollWidth));
  }, [display]);

  // Measured before paint so a formula that does not fit never shows a frame
  // of itself cut off without its slider; again whenever the column changes
  // width (window, margin, orientation) or the formula does (KaTeX's fonts
  // arriving after the markup).
  useLayoutEffect(() => {
    measure();
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(scroller);
    const paragraph = scroller.closest('p');
    if (paragraph) observer.observe(paragraph);
    // The formula's own runs, not `.katex`: an inline formula's `.katex` is a
    // plain inline box, which a ResizeObserver never reports on. The runs are
    // inline blocks, so they do report when KaTeX's fonts swap in.
    for (const run of scroller.querySelectorAll('.katex-html > .base')) observer.observe(run);
    // And the font load itself, which does not wait for a rendering frame.
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    fonts?.addEventListener?.('loadingdone', measure);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener?.('loadingdone', measure);
    };
  }, [measure, html, inlineWide]);

  const scrollTo = value => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollLeft = value;
    setPosition(value);
  };

  const wide = display || inlineWide;
  const scrolls = hidden > 0;

  return (
    <span
      className="rd-math"
      data-wide={wide ? '' : undefined}
      data-scrolls={scrolls ? '' : undefined}
    >
      <Tag
        {...rest}
        ref={scrollerRef}
        className={[rest.className, 'rd-math-scroller'].filter(Boolean).join(' ')}
        onScroll={scrolls ? event => setPosition(event.currentTarget.scrollLeft) : undefined}
        dangerouslySetInnerHTML={markup}
      />
      {scrolls && (
        <input
          type="range"
          className="rd-math-slider"
          min={0}
          max={hidden}
          step={1}
          value={Math.round(position)}
          aria-label="Scroll the formula sideways"
          aria-valuetext={sliderValueText(position, hidden)}
          style={{ '--rd-math-thumb': `${thumb}px` }}
          onChange={event => scrollTo(Number(event.target.value))}
          onKeyDown={event => {
            const target = sliderKeyTarget(event.key, position, hidden);
            if (target === null) return;
            // Handled here, not left to the range: its own arrow step is one
            // pixel, and the paragraph around it must not take the key either.
            event.preventDefault();
            event.stopPropagation();
            scrollTo(target);
          }}
        />
      )}
    </span>
  );
}

/**
 * Scientific text with highlight marks.
 *
 * Kept separate from `ScientificText` on purpose: that component is used all
 * over the feed and the magazine, and this one adds a render plan that has to
 * interleave marks with KaTeX output. The maths rendering is identical — the
 * same on-demand chunk, the same raw-LaTeX fallback until it lands — and the
 * difference is only that text runs may be wrapped in a <mark>.
 *
 * It used to import KaTeX directly instead, which broke that arrangement twice
 * over: the module rode into the entry chunk (a `modulepreload` of 258 KB on
 * every visit, math or no math), and nothing on this path ever asked for the
 * stylesheet. The reader only looked right when some other card on the feed had
 * happened to load it; on a paper whose abstract carried no formula, every
 * formula in the rewrite was printed twice — KaTeX's visual copy followed by the
 * MathML copy it hides by clipping, with no stylesheet present to clip it.
 *
 * Every run is stamped with the `start`/`end` it occupies in the normalized
 * paragraph. Nothing about the layout depends on them — they exist so a reader
 * can turn a DOM selection back into a range in the source, which is the only
 * way a selection that touches a formula can be anchored at all (the rendered
 * maths shares no characters with the `$...$` it came from).
 */
export default function HighlightedScientificText({ children, highlights = [] }) {
  const text = Array.isArray(children) ? children.join('') : children;
  const plan = buildHighlightPlan(text, highlights);
  const hasMath = plan.some(item => item.type === 'math');
  const [, rerender] = useReducer(count => count + 1, 0);

  useEffect(() => {
    if (!hasMath || getKatex()) return undefined;
    let active = true;
    loadKatex().then(loaded => {
      if (active && loaded) rerender();
    });
    return () => { active = false; };
  }, [hasMath]);

  const katex = getKatex();

  return (
    <>
      {plan.map((item, index) => {
        const bounds = { 'data-start': item.start, 'data-end': item.end };
        // Transient states the reader drives: the pen stroke on a mark that was
        // just made, and the wash on a selection still deciding. Attributes
        // rather than classes because each is removed again a moment later, and
        // an attribute is the cheaper thing to toggle.
        const marks = item.kind
          ? {
            'data-fresh': item.fresh ? '' : undefined,
            'data-proposed': item.proposed ? '' : undefined,
          }
          : {};
        const markClassFor = kind => [
          'rd-mark',
          `rd-mark--${kind}`,
          `rd-mark--${item.source}`,
          item.pending ? 'rd-mark--pending' : '',
          // The model's underline goes on running under the reader's own mark
          // (utils/textHighlights.js keeps both and says which is beneath).
          item.under?.includes('ai') && item.source !== 'ai' ? 'rd-mark--over-ai' : '',
        ].filter(Boolean).join(' ');

        if (item.type === 'math') {
          // A formula inside a highlight is wrapped whole. `<mark>` only paints
          // a background and inherits colour, so KaTeX's markup is untouched by
          // being inside one — which is what makes marking it safe at all.
          const Tag = item.kind ? 'mark' : 'span';
          const markClass = item.kind ? markClassFor(item.kind) : undefined;
          let html = null;
          if (katex) {
            try {
              html = katex.renderToString(katexSource(item), {
                displayMode: item.display,
                throwOnError: true,
                strict: 'ignore',
                trust: false,
              });
            } catch {
              html = null;
            }
          }

          // Until the chunk lands — and for anything KaTeX refuses — the LaTeX
          // source shows. It is readable, and it is what the highlight offsets
          // were measured against either way.
          // Marked maths carries the same id as any other run of its
          // highlight: a tap on the formula is a tap on the highlight.
          const mathId = item.kind ? item.id || undefined : undefined;
          return html === null
            ? <Tag key={`math-raw-${index}`} {...bounds} {...marks} data-math="" data-highlight-id={mathId} className={markClass}>{item.raw}</Tag>
            : (
              <MathRun
                key={`math-${index}`}
                Tag={Tag}
                display={Boolean(item.display)}
                html={html}
                {...bounds}
                {...marks}
                data-math=""
                data-highlight-id={mathId}
                className={markClass}
              />
            );
        }

        if (item.type === 'mark') {
          return (
            <mark
              key={`mark-${index}`}
              {...bounds}
              {...marks}
              className={markClassFor(item.kind)}
              data-highlight-id={item.id || undefined}
            >
              {displayProse(item.value)}
            </mark>
          );
        }

        return (
          <span key={`text-${index}`} {...bounds}>
            {displayProse(item.value)}
          </span>
        );
      })}
    </>
  );
}
