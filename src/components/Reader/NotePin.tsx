import { Sparkle, User } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

export interface NotePinData { number: number; note: string; kind?: string; origin: string; where: string }

export default function NotePin({ number, note, kind, origin, where }: NotePinData) {
  return (
    <Popover>
      <PopoverTrigger
        render={(
          <button
            type="button"
            className="rd-pin"
            data-pin={number}
            aria-label={`Note ${number}`}
            onKeyDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => event.stopPropagation()}
          />
        )}
      />
      <PopoverContent side="top" align="center" className="rd-pin-pop">
        <p className="rd-pin-pop-note">
          <span className="rd-pin-pop-number">{number}</span>
          {note}
        </p>
        <span className="rd-pin-pop-source">
          {kind === 'ai' ? <Sparkle size={13} aria-hidden="true" /> : <User size={13} aria-hidden="true" />}
          {origin} · {where}
        </span>
      </PopoverContent>
    </Popover>
  );
}
