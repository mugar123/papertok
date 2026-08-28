import { useEffect, useRef } from 'react';
import { isUsableSelection, SELECTION_SETTLE_MS } from '../utils/readerSelection.js';

/**
 * Touch selection, which the reader could not see before.
 *
 * `onMouseUp` is the desktop path and it never fires for a touch selection
 * gesture: a long press hands the gesture to the OS, which shows its own
 * callout and emits no mouse event when the handles are released. So on a
 * coarse pointer the reader listens to `selectionchange` on the document and
 * waits for it to hold still — capturing on the first event would freeze the
 * first partial range and lose the precision the handles exist to give.
 *
 * Paragraph identity comes off the DOM rather than a per-paragraph callback:
 * every `<p class="rd-p">` already carries `data-section` and `data-paragraph`,
 * so one document listener covers the whole document. The paragraph *text*
 * comes from `sections`, never from `textContent` — KaTeX renders every formula
 * twice and the accessible copy would come along for the ride.
 */
export function useTouchSelection({ scrollRef, sections, onSelect, enabled }) {
  const timerRef = useRef(null);
  const sectionsRef = useRef(sections);
  const onSelectRef = useRef(onSelect);

  // Kept current via effects rather than assigned during render: a ref write
  // is a side effect, and the `selectionchange` listener below only ever
  // reads these refs from inside its own (later) effect callbacks.
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    if (!enabled) return undefined;

    const capture = () => {
      const selection = window.getSelection();
      if (!selection) return;
      if (!isUsableSelection({
        isCollapsed: selection.isCollapsed,
        rangeCount: selection.rangeCount,
        text: selection.toString(),
      })) return;

      const anchorNode = selection.anchorNode;
      const element = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
      const paragraph = element?.closest?.('p.rd-p');
      if (!paragraph) return;
      // Fail closed: no container to confirm against means no capture, not an
      // unchecked one. A missing ref is not a reason to widen what counts.
      if (!scrollRef.current || !scrollRef.current.contains(paragraph)) return;

      const sectionId = paragraph.dataset.section;
      const paragraphIndex = Number(paragraph.dataset.paragraph);
      // String(...) on both sides, matching the coercion PaperReader.jsx
      // already uses when resolving a section id round-tripped through a DOM
      // dataset attribute (always a string) against `sections[].id` (a string
      // today, but nothing enforces that at this boundary).
      const section = sectionsRef.current
        ?.find(item => String(item.id) === String(sectionId));
      const text = section?.paragraphs?.[paragraphIndex];
      if (typeof text !== 'string') return;

      onSelectRef.current(sectionId, paragraphIndex, text, paragraph);
    };

    const onSelectionChange = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(capture, SELECTION_SETTLE_MS);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      window.clearTimeout(timerRef.current);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [enabled, scrollRef]);
}
