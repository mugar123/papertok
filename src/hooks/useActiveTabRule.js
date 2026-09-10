import { useLayoutEffect, useState } from 'react';
import { ruleTransform } from '../utils/navRule.js';

/**
 * Where a row's yellow rule goes, measured after every render.
 *
 * The rule is one element that TRAVELS between tabs, rather than a border each
 * tab paints for itself. It is positioned with a transform a CSS transition
 * animates, so it keeps sliding on the compositor while the main thread is
 * busy mounting whatever the new tab holds — which is exactly when it is busy
 * (measured on the Explorer: switching an institution from Papers to Authors
 * swaps 30 rows for 30 cards and the document loses 4332px in one frame).
 *
 * The active element is re-measured after every render AND when the row
 * resizes, because activating a tab makes it semibold: its own width changes
 * and it shifts its neighbours. The first measurement is applied WITHOUT a
 * transition — `measured` is what the caller puts the arming class behind — so
 * the rule does not slide in from the row's left edge on load.
 *
 * The maths lives in `utils/navRule.js` and is shared with the navbar. This
 * hook is deliberately NOT shared with it: the navbar's copy is measured,
 * reviewed and working, and reaching into it to extract a hook would put a
 * component nobody asked to change into this diff.
 *
 * The row arrives as a NODE held in state, not as a ref object, and that is
 * load-bearing here in a way it is not in the navbar: the Explorer's tab strip
 * does not exist while the entity is loading — the skeleton draws its own — so
 * a `useLayoutEffect` reading `ref.current` runs once against `null` and, since
 * mounting the real strip changes none of its dependencies, never runs again.
 * Measured 2026-09-10 with a ref: the rule was in the DOM, armed, its
 * transitions running, and permanently invisible, because its transform was
 * never computed. A callback ref re-renders when the node attaches, so the
 * measurement happens the moment there is something to measure.
 *
 * @param {HTMLElement|null} row       the row the rule is absolute against
 * @param {string} activeKey           re-measure when this changes
 * @param {string} activeSelector      how to find the active element inside the row
 * @returns {{ transform: string, measured: boolean }}
 */
export function useActiveTabRule(row, activeKey, activeSelector) {
  const [rule, setRule] = useState({ transform: '', measured: false });

  useLayoutEffect(() => {
    if (!row) return undefined;
    const measure = () => {
      const active = row.querySelector(activeSelector);
      if (!active) {
        setRule(current => (current.transform ? { ...current, transform: '' } : current));
        return;
      }
      const inset = parseFloat(getComputedStyle(active).paddingLeft) || 0;
      const transform = ruleTransform(active.getBoundingClientRect(), row.getBoundingClientRect().left, inset);
      setRule(current => (current.transform === transform && current.measured ? current : { transform, measured: true }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.querySelectorAll(activeSelector.replace(/\.active\b/, '')).forEach(tab => observer.observe(tab));
    return () => observer.disconnect();
  }, [row, activeKey, activeSelector]);

  return rule;
}
