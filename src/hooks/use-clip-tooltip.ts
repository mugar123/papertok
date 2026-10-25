import { useRef, useState } from 'react';

/**
 * A tooltip that only opens when its text is cut: ellipsed by its width,
 * held to a line count by its height, or shortened before render (`cut`).
 * Spread `open` and `onOpenChange` on the Tooltip, put `ref` on the element
 * whose overflow says the text is cut.
 */
export default function useClipTooltip<Element extends HTMLElement = HTMLSpanElement>(cut = false) {
  const ref = useRef<Element | null>(null);
  const [open, setOpen] = useState(false);
  const onOpenChange = (next: boolean) => {
    const node = ref.current;
    const clipped = Boolean(node) && (node!.scrollWidth > node!.clientWidth || node!.scrollHeight > node!.clientHeight);
    setOpen(next && (cut || clipped));
  };
  return { ref, open, onOpenChange };
}
