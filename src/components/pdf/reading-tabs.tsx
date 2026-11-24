import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.tsx';
import './reading-tabs.css';

export type ReadingView = 'paper' | 'plain';

/** The paper's two ways to read, at the top of the viewer and of the plain-words reader. */
export function ReadingTabs({ current, onChange }: { current: ReadingView; onChange: (view: ReadingView) => void }) {
  return (
    <ToggleGroup
      size="sm"
      className="rd-reading-tabs"
      aria-label="How to read this paper"
      value={[current]}
      onValueChange={([next]) => { if (next === 'paper' || next === 'plain') onChange(next); }}
    >
      <ToggleGroupItem value="paper">Paper</ToggleGroupItem>
      <ToggleGroupItem value="plain">Plain words</ToggleGroupItem>
    </ToggleGroup>
  );
}
