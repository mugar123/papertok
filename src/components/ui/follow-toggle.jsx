import { Check } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Toggle } from './toggle.jsx';
import './follow-toggle.css';

/**
 * The one Follow control: authors, institutions, projects and topics in the
 * Explorer, and people on a public profile. An on/off state, so a Toggle
 * (`aria-pressed`): off, it invites in ink; on, it is the bordered chip that
 * says the relationship exists, with a check. Pressing it again unfollows.
 *
 * The labels come from the caller, which owns the language.
 */
export function FollowToggle({ pressed, followLabel, followingLabel, className, ...props }) {
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
