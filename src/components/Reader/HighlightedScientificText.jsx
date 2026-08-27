import { useEffect, useReducer } from 'react';
import { getKatex, loadKatex } from '../../utils/katexLoader.js';
import { buildHighlightPlan } from '../../utils/textHighlights.js';

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
              html = katex.renderToString(item.value, {
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
          return html === null
            ? <Tag key={`math-raw-${index}`} {...bounds} {...marks} data-math="" className={markClass}>{item.raw}</Tag>
            : (
              <Tag
                key={`math-${index}`}
                {...bounds}
                {...marks}
                data-math=""
                className={markClass}
                dangerouslySetInnerHTML={{ __html: html }}
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
              {item.value}
            </mark>
          );
        }

        return (
          <span key={`text-${index}`} {...bounds}>
            {item.value}
          </span>
        );
      })}
    </>
  );
}
