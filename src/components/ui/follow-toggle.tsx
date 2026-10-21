import type { StyledProps } from './props.ts';

import { Check, UserCheck, UserPlus } from '@phosphor-icons/react';
import { cn } from '../../lib/utils.ts';
import { Toggle } from './toggle.tsx';
import './follow-toggle.css';

/**
 * The one Follow control: authors, institutions, projects and topics in the
 * Explorer. An on/off state, so a Toggle (`aria-pressed`): off, it invites in
 * ink; on, it is the bordered chip that says the relationship exists, with a
 * check. Pressing it again unfollows.
 *
 * The labels come from the caller, which owns the language.
 */
export function FollowToggle({ pressed, followLabel, followingLabel, compact = false, className, ...props }: StyledProps<typeof Toggle> & { followLabel: string; followingLabel: string; compact?: boolean }) {
  // `compact`: an icon alone, for a tight bar; the label becomes its name.
  if (compact) {
    return (
      <Toggle
        variant="outline"
        className={cn('follow-toggle follow-toggle--compact', className)}
        pressed={pressed}
        aria-label={followLabel}
        {...props}
      >
        {pressed ? <UserCheck size={18} aria-hidden="true" /> : <UserPlus size={18} aria-hidden="true" />}
      </Toggle>
    );
  }
  return (
    <Toggle
      variant="outline"
      className={cn('follow-toggle', className)}
      pressed={pressed}
      {...props}
    >
      {pressed
        ? <><Check size={14} aria-hidden="true" /> <span>{followingLabel}</span></>
        : <span>{followLabel}</span>}
    </Toggle>
  );
}
