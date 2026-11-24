import { useLayoutEffect, useRef, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.tsx';
import './reading-tabs.css';

type ReadingView = 'paper' | 'summary';

/**
 * The paper's two ways to read, at the top of the viewer. The raised chip slides to the tab
 * chosen, so the switch reads as one control moving rather than two buttons swapping colour.
 */
export function ReadingTabs({ current, onChange }: { current: ReadingView; onChange: (view: ReadingView) => void }) {
  const group = useRef<HTMLDivElement | null>(null);
  const chip = useRef<HTMLSpanElement | null>(null);
  // The chip takes its first place without sliding; only a switch after that moves it.
  const [placed, setPlaced] = useState(false);
  useLayoutEffect(() => {
    const item = group.current?.querySelector<HTMLElement>(`[data-view="${current}"]`);
    if (!item || !chip.current) return;
    chip.current.style.width = `${item.offsetWidth}px`;
    chip.current.style.transform = `translateX(${item.offsetLeft}px)`;
    if (!placed) requestAnimationFrame(() => setPlaced(true));
  }, [current, placed]);
  return (
    <ToggleGroup
      ref={group}
      size="sm"
      className="rd-reading-tabs"
      data-placed={placed || undefined}
      aria-label="How to read this paper"
      value={[current]}
      onValueChange={([next]) => { if (next === 'paper' || next === 'summary') onChange(next); }}
    >
      <span ref={chip} className="rd-reading-chip" aria-hidden="true" />
      <ToggleGroupItem value="paper" data-view="paper" className="rd-reading-tab">Paper</ToggleGroupItem>
      <ToggleGroupItem value="summary" data-view="summary" className="rd-reading-tab">AI summary</ToggleGroupItem>
    </ToggleGroup>
  );
}
