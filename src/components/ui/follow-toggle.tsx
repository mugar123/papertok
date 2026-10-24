import type { StyledProps } from './props.ts';

import { useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import { UserCircleMinus, UserCirclePlus } from '@phosphor-icons/react';
import { cn } from '../../lib/utils.ts';
import { pulseIcon } from '../../utils/motionCurves.ts';
import { Toggle } from './toggle.tsx';
import './follow-toggle.css';

type FollowToggleProps = StyledProps<typeof Toggle> & { followLabel: string; followingLabel: string; compact?: boolean };

/**
 * The one Follow control: authors, institutions, projects and topics in the
 * Explorer. An on/off state, so a Toggle (`aria-pressed`), drawn like the
 * feed's Like and Save: an outline button whose icon fills once on and
 * pulses on the press. Pressing it again unfollows. `compact` keeps only the
 * icon, with the label as its name.
 *
 * The labels come from the caller, which owns the language.
 */
export function FollowToggle({ pressed, followLabel, followingLabel, compact = false, className, onClick, ...props }: FollowToggleProps) {
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const reducedMotion = useReducedMotion();
  const handleClick: NonNullable<FollowToggleProps['onClick']> = (event) => {
    // The box, not the glyph: following swaps the glyph mid-pulse.
    if (!reducedMotion) pulseIcon(iconRef.current, !pressed);
    onClick?.(event);
  };
  return (
    <Toggle
      variant="outline"
      className={cn('follow-toggle', compact && 'follow-toggle--compact', className)}
      pressed={pressed}
      aria-label={compact ? followLabel : undefined}
      onClick={handleClick}
      {...props}
    >
      <span className="follow-toggle-icon" ref={iconRef}>
        {pressed
          ? <UserCircleMinus size={compact ? 18 : 16} weight="fill" aria-hidden="true" />
          : <UserCirclePlus size={compact ? 18 : 16} aria-hidden="true" />}
      </span>
      {!compact && <span>{pressed ? followingLabel : followLabel}</span>}
    </Toggle>
  );
}
