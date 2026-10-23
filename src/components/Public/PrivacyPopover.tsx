import { useState } from 'react';
import { ArrowUpRight, ShieldCheck } from '@phosphor-icons/react';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import { cn } from '../../lib/utils.ts';
import { ANALYTICS_CONSENT } from '../../services/analyticsService.ts';
import { buttonVariants } from '../ui/button-variants.ts';
import { Label } from '../ui/label.tsx';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover.tsx';
import { Switch } from '../ui/switch.tsx';
import './PrivacyPopover.css';

const COPY = {
  name: 'Privacy',
  lede: 'Without an account, PaperTok counts pages and actions anonymously, without cookies. Never your searches, the papers you read or your interests.',
  toggle: 'Allow usage analytics',
  kept: 'Your choice is kept in this browser.',
  saveFailed: 'Not saved: this browser is blocking site storage, so analytics is unchanged.',
  policy: 'Privacy policy',
  newTab: ' (opens in a new tab)',
};

// The trigger where the host has no icon button of its own: the shared ghost
// icon button, the size of the explorer's Share.
const ICON_BUTTON = buttonVariants({ variant: 'ghost', size: 'icon-sm' });

/**
 * A visitor without an account is measured until they object, and has no
 * Settings to object in: this is their switch, and their way to the policy,
 * from the first screen of the welcome on and at the top of every page a
 * shared link opens. The host passes its own chrome class, as it does for
 * ThemeToggle. The choice belongs to analyticsService and goes through the
 * analytics context, exactly like the Settings switch, so the two cannot
 * disagree.
 */
export default function PrivacyPopover({ className = ICON_BUTTON }) {
  const { consent, updateConsent } = useAnalyticsConsent();
  const [saveFailed, setSaveFailed] = useState(false);

  // `updateConsent` only moves the switch when the choice was stored, so a
  // browser that refuses storage leaves it where it was; say so in words.
  // Cleared first: a live region speaks only when its text changes, so a
  // second refusal would otherwise go unheard.
  const choose = async (checked: boolean) => {
    setSaveFailed(false);
    const saved = await updateConsent(checked ? ANALYTICS_CONSENT.ANONYMOUS : ANALYTICS_CONSENT.DENIED);
    setSaveFailed(!saved);
  };

  return (
    <Popover>
      <PopoverTrigger
        className={`${className} privacy-popover-trigger`}
        aria-label={COPY.name}
        title={COPY.name}
      >
        <ShieldCheck size={17} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="privacy-popover">
        <PopoverTitle className="privacy-popover-title">{COPY.name}</PopoverTitle>
        <PopoverDescription className="privacy-popover-lede">{COPY.lede}</PopoverDescription>
        {/* Named by the label it sits in: Base UI points `aria-labelledby` at
            it, and an `aria-label` as well would be read out twice. */}
        <Label className="privacy-popover-switch">
          {COPY.toggle}
          <Switch checked={consent !== ANALYTICS_CONSENT.DENIED} onCheckedChange={choose} />
        </Label>
        {/* Only the failure is announced; the note beside it is not news. */}
        <p className={`privacy-popover-status${saveFailed ? ' is-failed' : ''}`}>
          {saveFailed ? null : COPY.kept}
          <span role="status">{saveFailed ? COPY.saveFailed : ''}</span>
        </p>
        {/* A link that looks like a ghost button, not a Button rendered as a
            link: Base UI gives a non-button element `role="button"`, and this
            one navigates. */}
        <a
          href="/privacy.html"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'privacy-popover-policy')}
        >
          {COPY.policy}
          <ArrowUpRight size={14} aria-hidden="true" />
          <span className="visually-hidden">{COPY.newTab}</span>
        </a>
      </PopoverContent>
    </Popover>
  );
}
