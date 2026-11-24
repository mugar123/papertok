import { useLayoutEffect, useRef, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.tsx';
import './reading-tabs.css';

export type ReadingView = 'paper' | 'summary' | 'listen';

const LABELS: Record<ReadingView, string> = { paper: 'Paper', summary: 'AI summary', listen: 'Listen' };
const PAPER_AND_SUMMARY: readonly ReadingView[] = ['paper', 'summary'];

/**
 * The paper's ways to read, at the top of the viewer, in the order the viewer hands them: the
 * paper, listening to it, and its AI summary. The raised chip slides to the tab chosen, so the switch reads as one
 * control moving rather than buttons swapping colour.
 */
export function ReadingTabs({ current, views = PAPER_AND_SUMMARY, onChange }: { current: ReadingView; views?: readonly ReadingView[]; onChange: (view: ReadingView) => void }) {
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
  }, [current, placed, views]);
  return (
    <ToggleGroup
      ref={group}
      size="sm"
      className="rd-reading-tabs"
      data-placed={placed || undefined}
      aria-label="How to read this paper"
      value={[current]}
      onValueChange={([next]) => { const view = views.find(item => item === next); if (view) onChange(view); }}
    >
      <span ref={chip} className="rd-reading-chip" aria-hidden="true" />
      {views.map(view => <ToggleGroupItem key={view} value={view} data-view={view} className="rd-reading-tab">{LABELS[view]}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}
