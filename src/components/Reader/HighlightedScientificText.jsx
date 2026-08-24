import { Fragment } from 'react';
import katex from 'katex';
import { buildHighlightPlan } from '../../utils/textHighlights.js';

/**
 * Scientific text with highlight marks.
 *
 * Kept separate from `ScientificText` on purpose: that component is used all
 * over the feed and the magazine, and this one adds a render plan that has to
 * interleave marks with KaTeX output. The maths rendering is identical; the
 * difference is that text runs may be wrapped in a <mark>.
 */
export default function HighlightedScientificText({ children, highlights = [] }) {
  const text = Array.isArray(children) ? children.join('') : children;
  const plan = buildHighlightPlan(text, highlights);

  return (
    <>
      {plan.map((item, index) => {
        if (item.type === 'math') {
          try {
            return (
              <span
                key={`math-${index}`}
                dangerouslySetInnerHTML={{
                  __html: katex.renderToString(item.value, {
                    displayMode: item.display,
                    throwOnError: true,
                    strict: 'ignore',
                    trust: false,
                  }),
                }}
              />
            );
          } catch {
            return <Fragment key={`math-raw-${index}`}>{item.raw}</Fragment>;
          }
        }

        if (item.type === 'mark') {
          return (
            <mark
              key={`mark-${index}`}
              className={`rd-mark rd-mark--${item.kind} rd-mark--${item.source}`}
              data-highlight-id={item.id || undefined}
            >
              {item.value}
            </mark>
          );
        }

        return <Fragment key={`text-${index}`}>{item.value}</Fragment>;
      })}
    </>
  );
}
