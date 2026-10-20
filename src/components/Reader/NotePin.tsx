import { Sparkle, User } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

export interface NotePinData { number: number; note: string; kind?: string }

export default function NotePin({ number, note, kind }: NotePinData) {
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
        <span className="rd-pin-pop-head">
          {kind === 'ai' ? <Sparkle size={13} aria-hidden="true" /> : <User size={13} aria-hidden="true" />}
          <span className="rd-note-pin">{number}</span>
        </span>
        <p className="rd-pin-pop-note">{note}</p>
      </PopoverContent>
    </Popover>
  );
}
