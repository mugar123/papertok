import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  Check,
  CheckCircle,
  CircleNotch,
  Clock,
  Envelope,
  PaperPlaneTilt,
} from '@phosphor-icons/react';
import { useAuth } from '../../context/auth-context.tsx';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { emailServiceState } from '../../utils/email-health.ts';
import { emailFollowsNotice } from './email-follows-notice.ts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { Label } from '../ui/label.tsx';
import { Button } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { Switch } from '../ui/switch.tsx';
import useIsPhone from '../../hooks/use-is-phone.ts';
import '../settings/settings-sheet.css';
import './email-notification-modal.css';

const ERROR_COPY = {
  en: {
    EMAIL_NOT_CONFIGURED: 'Email updates have not been configured yet.',
    EMAIL_AUTH_REQUIRED: 'Sign in again to configure email updates.',
    EMAIL_ADDRESS_NOT_VERIFIED: 'Confirm your email address with your sign-in provider before enabling email updates.',
    EMAIL_REACTIVATION_REQUIRES_DIGEST: 'Reload your email preferences and check that the weekly digest is on.',
    EMAIL_REACTIVATION_CHANGED: 'Your email preferences changed while this was saving. Try again.',
    EMAIL_PROVIDER_AUTH_FAILED: 'The email provider rejected the configured credential.',
    EMAIL_SENDER_NOT_VERIFIED: 'The email sender domain has not been verified yet.',
    EMAIL_PROVIDER_LIMIT: 'The sending limit has temporarily been reached.',
    EMAIL_PROVIDER_RATE_LIMIT: 'Resend is limiting requests for now. Try again in a few minutes.',
    EMAIL_TEST_RATE_LIMIT: 'Wait one minute before sending another test.',
    EMAIL_TEST_DAILY_LIMIT: 'The daily limit for test emails has been reached. You can send another after 00:00 UTC.',
    EMAIL_TEST_OPENALEX_BUDGET: "PaperTok has paused test emails to keep the day's OpenAlex budget for opening papers and the feed. You can send one again by 00:00 UTC at the latest.",
    EMAIL_TEST_RECIPIENT_RESTRICTED: 'Resend rejected this recipient. Check that the sender domain is verified.',
    EMAIL_DATA_LOADING: 'We are still loading what you follow. Try again in a few seconds.',
    EMAIL_FOLLOWS_REQUIRED: 'Follow a topic, author, institution or project, choose your subjects, or connect ORCID to enable emails.',
    EMAIL_SEND_FAILED: 'The test email could not be sent.',
    EMAIL_TIMEOUT: 'The email service is taking too long.',
    EMAIL_UNAVAILABLE: 'The email service is not available right now.',
  },
};

const MIN_TEST_SENDING_MS = 900;
const TEST_SENT_VISIBLE_MS = 5000;

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/* The digest can carry three, five or ten papers. `items` gives the Select
   the label to show for the chosen value, so the trigger reads "5" and not
   the number's own string. */
const MAX_PAPERS_OPTIONS = [3, 5, 10].map(value => ({ value, label: String(value) }));

/**
 * SettingsPage keeps this mounted and drives it through `isOpen`, so the
 * Dialog is controlled from outside: every way out (the X, Escape, the
 * scrim) reports `onOpenChange(false)`, which is the parent's `onClose`, and
 * Base UI plays the leave before the popup goes.
 */
export default function EmailNotificationModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { language } = useLanguage();
  const { emailDigestPending, user } = useAuth();
  const enabledId = useId();
  const countId = useId();
  const reactivationId = useId();
  const {
    preferences,
    health,
    loading,
    saving,
    testing,
    notificationDataReady,
    digestCovered,
    hasCitationSource,
    digestSendReady,
    digestTurnedOff,
    digestSubscribed,
    reactivation,
    refreshing,
    savePreferences,
    sendTest,
    refreshPreferences,
  } = useEmailNotifications();
  const { followedEntities } = useFollowing();
  const followsNotice = emailFollowsNotice(followedEntities, emailDigestPending, digestCovered, hasCitationSource);
  // Only what the reader changed. Everything else follows the saved preferences,
  // so what the read on opening brings, or a subscription that finishes starting
  // while this is open, shows without reopening it, and an edit is never overwritten.
  const [edits, setEdits] = useState<Partial<typeof preferences> | null>(null);
  const draft = useMemo(() => ({ ...preferences, ...edits }), [preferences, edits]);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testState, setTestState] = useState('idle');
  const [savingReactivation, setSavingReactivation] = useState(false);
  const reactivationBoxRef = useRef<HTMLElement>(null);
  // The Retry or withdraw button that started a reminder request. Both unmount
  // once the request succeeds; focus then moves to the checkbox, unless the
  // reader moved it elsewhere meanwhile.
  const reminderTrigger = useRef<HTMLElement | null>(null);
  const testFeedbackTimerRef = useRef<number | null>(null);
  const isPhone = useIsPhone();

  // Escape, the scrim and the focus trap are the Dialog's own; what is left
  // here is the draft, dropped on every opening so it follows the saved preferences.
  useEffect(() => {
    if (!isOpen) return undefined;
    const timeoutId = setTimeout(() => {
      setEdits(null);
      setFeedback(null);
      setTestState('idle');
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      clearTimeout(testFeedbackTimerRef.current!);
    };
  }, [isOpen]);

  // Another tab or device may have turned the email on or off since this tab
  // last read it, so every opening reads it again, and the controls wait for
  // that read (`refreshing`): a save made from an old state could undo it.
  // It starts a tick later, after the reset above has cleared the feedback
  // line, so a read that fails at once still leaves its message there.
  useEffect(() => {
    if (!isOpen) return undefined;
    let closed = false;
    const timeoutId = setTimeout(() => {
      refreshPreferences().catch(() => {
        if (!closed) setFeedback({ type: 'error', text: "We couldn't check your email settings, so what you see may be out of date." });
      });
    }, 0);
    return () => {
      closed = true;
      clearTimeout(timeoutId);
    };
  }, [isOpen, refreshPreferences]);

  // Another tab may have granted or withdrawn reminders since the provider
  // last read them, so every opening asks again.
  const refreshReactivation = reactivation.refresh;
  useEffect(() => {
    if (isOpen) void refreshReactivation();
  }, [isOpen, refreshReactivation]);

  const handleSave = async () => {
    setFeedback(null);
    try {
      await savePreferences(draft);
      setEdits(null);
      setFeedback({
        type: 'success',
        text: draft.enabled
          ? ('Email updates enabled.')
          : ('Email updates disabled.'),
      });
    } catch (error) {
      setFeedback({ type: 'error', text: ERROR_COPY[language][(error as { code?: string }).code as keyof typeof ERROR_COPY.en] || ERROR_COPY[language].EMAIL_UNAVAILABLE });
    }
  };

  const handleTest = async () => {
    const startedAt = Date.now();
    setFeedback(null);
    setTestState('sending');
    clearTimeout(testFeedbackTimerRef.current!);
    try {
      const result = await sendTest({ ...draft, enabled: true });
      const remainingSendingTime = MIN_TEST_SENDING_MS - (Date.now() - startedAt);
      if (remainingSendingTime > 0) await wait(remainingSendingTime);
      const saved = result.preferences;
      setEdits(null);
      setFeedback({
        type: 'success',
        text: `Test email sent to ${saved.email}.`,
      });
      setTestState('sent');
      testFeedbackTimerRef.current = setTimeout(() => setTestState('idle'), TEST_SENT_VISIBLE_MS);
    } catch (error) {
      setTestState('idle');
      setFeedback({ type: 'error', text: ERROR_COPY[language][(error as { code?: string }).code as keyof typeof ERROR_COPY.en] || ERROR_COPY[language].EMAIL_UNAVAILABLE });
    }
  };

  const handleReactivation = async (checked: boolean) => {
    setFeedback(null);
    setSavingReactivation(true);
    try {
      await reactivation.save(checked);
      setFeedback({ type: 'success', text: checked ? 'Reminder preference saved.' : 'Reminder turned off.' });
    } catch (error) {
      setFeedback({ type: 'error', text: ERROR_COPY[language][(error as { code?: string }).code as keyof typeof ERROR_COPY.en] || 'Your reminder preference could not be saved. Try again.' });
    } finally {
      setSavingReactivation(false);
    }
  };

  // A layout effect runs before Base UI's focus manager moves focus to the
  // dialog itself, which it does when a focused element disappears.
  useLayoutEffect(() => {
    const trigger = reminderTrigger.current;
    if (!trigger || trigger.isConnected) return;
    reminderTrigger.current = null;
    const active = document.activeElement;
    if (!active || active === document.body) reactivationBoxRef.current?.focus();
  }, [reactivation.enabled, reactivation.unavailable]);

  const emailService = emailServiceState(health);
  const toggleDisabled = loading || (emailService === 'down' && !draft.enabled) || (!digestCovered && !draft.enabled);
  const optionsDisabled = !draft.enabled || loading || refreshing;
  const statusUnknown = !loading && emailService === 'unknown';
  const providerDown = !loading && emailService === 'down';
  // Withdrawing never waits on the digest preferences: when their read failed,
  // a reader who gave consent can still take it back.
  const reactivationReason = loading || reactivation.loading ? 'Loading your reminder preference.'
    : reactivation.unavailable ? 'Your reminder preference is temporarily unavailable. Try again.'
    // This tab read the digest as off; the read on opening says whether another
    // tab or device turned reminders on since.
    : digestSubscribed === false ? (!reactivation.known ? 'Loading your reminder preference.'
      : reactivation.enabled
        ? 'Reminders were turned on in another tab or on another device. You can turn them off here, or reload to see your current digest settings.'
        : 'Turn on and save your weekly digest first.')
    : digestSubscribed === null ? (reactivation.enabled
      ? 'Your digest settings could not be loaded. You can still turn reminders off.'
      : 'Your digest settings could not be loaded. Reload the page to turn reminders on.')
    : !user?.emailVerified && !reactivation.enabled ? 'Verify your email address to turn reminders on.'
    : null;

  // On a phone the same content is a bottom sheet, like the other sheets
  // Settings opens; the handle and a swipe take the place of the X.
  const Title = isPhone ? DrawerTitle : DialogTitle;
  const Description = isPhone ? DrawerDescription : DialogDescription;
  const content = (
    <>
      <header>
        <div className={`email-notification-icon${providerDown ? ' is-down' : ''}`}><Envelope size={20} aria-hidden="true" /></div>
        <div>
          <Title>{'Email updates'}</Title>
          <Description>{'Receive a weekly digest even when PaperTok is closed.'}</Description>
        </div>
      </header>

      <div className="email-notification-body" data-base-ui-swipe-ignore="">
        {statusUnknown && (
          <div className="email-notification-provider-warning is-info">
            <strong>{'Email status unknown'}</strong>
            <span>{'PaperTok could not check the email service just now. You can still change these settings. Reload the page in a few minutes to check again.'}</span>
          </div>
        )}
        {providerDown && (
          <div className="email-notification-provider-warning">
            <strong>{'Email updates unavailable'}</strong>
            <span>{health.code === 'EMAIL_PROVIDER_AUTH_FAILED'
              ? ('The email provider did not accept the saved credential.')
              : health.code === 'EMAIL_SENDER_NOT_VERIFIED'
                ? ('Resend has not verified the configured sender domain yet.')
                : health.code === 'EMAIL_SENDER_STATUS_UNKNOWN'
                  ? ('PaperTok cannot confirm the sender domain with the current Resend key.')
                : ('The email provider is not available right now.')}</span>
          </div>
        )}
        {digestTurnedOff && (
          <div className="email-notification-provider-warning is-info">
            <strong>{'Email updates turned off'}</strong>
            <span>Follow a topic, author, institution or project, choose your subjects, or connect ORCID. Then switch email updates back on here.</span>
          </div>
        )}
        {!loading && notificationDataReady && followsNotice && (
          <div className="email-notification-provider-warning is-follows">
            <strong><Link to={hasCitationSource ? '/profile' : '/settings/following'} onClick={onClose}>{followsNotice.heading}</Link></strong>
            <span>{followsNotice.body}</span>
          </div>
        )}
        <div className="email-notification-toggle-row">
          <Label htmlFor={enabledId}>
            <strong>{'Enable email updates'}</strong>
            <small>{'They will be sent to'} {draft.email || preferences.email}</small>
          </Label>
          <Switch
            id={enabledId}
            className="email-notification-switch"
            checked={Boolean(draft.enabled)}
            onCheckedChange={checked => setEdits(current => ({ ...current, enabled: checked }))}
            disabled={toggleDisabled}
            // Read-only, not disabled, during the read on opening: the switch is
            // where focus lands, and a disabled control would drop it.
            readOnly={refreshing}
            aria-busy={refreshing}
          />
        </div>

        <div className="email-notification-toggle-row email-notification-reminder">
          <div>
            <Label htmlFor={reactivationId} id={`${reactivationId}-label`}><strong>Weekly digest reminder</strong></Label>
            <small id={`${reactivationId}-description`}>
              Allow PaperTok to keep your last signed-in visit to prepare a future digest after seven days away.
              {' PaperTok uses it for 30 days, then usually deletes it within a day; Cloudflare’s point-in-time history may keep it 30 more days, and PaperTok never reads or restores it.'}
              <span role="status">{reactivationReason && ` ${reactivationReason}`}</span>
              {!reactivationReason && <> This choice saves immediately.</>}
            </small>
            {reactivation.unavailable && !loading && (
              <>
                <Button variant="outline" size="sm" disabled={savingReactivation} onClick={event => { reminderTrigger.current = event.currentTarget; void reactivation.refresh(); }}>Retry</Button>
                {/* A failed read may hide consent another tab gave. */}
                {!reactivation.enabled && (
                  <Button type="button" variant="outline" size="sm" disabled={savingReactivation} onClick={event => { reminderTrigger.current = event.currentTarget; void handleReactivation(false); }}>Turn off reminders</Button>
                )}
              </>
            )}
          </div>
          <Checkbox
            ref={reactivationBoxRef}
            id={reactivationId}
            className="size-6"
            aria-labelledby={`${reactivationId}-label`}
            aria-describedby={`${reactivationId}-description`}
            aria-busy={savingReactivation}
            checked={reactivation.enabled}
            indeterminate={reactivation.unavailable && !reactivation.enabled}
            disabled={Boolean(reactivationReason && !reactivation.enabled) || saving || testing}
            readOnly={savingReactivation}
            onCheckedChange={checked => { void handleReactivation(checked); }}
          />
        </div>

        <div className={`email-notification-options ${draft.enabled ? '' : 'is-disabled'}`}>
          <div className="email-notification-count">
            <Label htmlFor={countId}>
              <strong>{'Maximum per email'}</strong>
              <small>{'PaperTok will send fewer when there are not enough high-quality matches'}</small>
            </Label>
            <Select
              items={MAX_PAPERS_OPTIONS}
              value={draft.maxPapers || 5}
              onValueChange={value => setEdits(current => ({ ...current, maxPapers: Number(value) }))}
              disabled={optionsDisabled}
            >
              <SelectTrigger id={countId} className="email-notification-count-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAX_PAPERS_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* The sheet keeps this line's room, so a result does not lift the
            whole sheet; it is also where the result is announced. */}
        <div className="email-notification-feedback-slot" role="status">
          <AnimatePresence initial={false}>
          {refreshing && !feedback && <p className="email-notification-feedback">Checking your email settings…</p>}
          {feedback && (
            <motion.p className={`email-notification-feedback is-${feedback.type}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.14 } }}>
              {feedback.type === 'success' && <Check size={15} />} {feedback.text}
            </motion.p>
          )}
          </AnimatePresence>
        </div>

        <div className="email-notification-schedule">
          <Clock size={16} aria-hidden="true" />
          <span>{'Prepared on Mondays when there are updates. Delivery may take longer if sending is limited.'}</span>
        </div>
      </div>

      <footer>
        <button
          type="button"
          className={`email-notification-test ${testState === 'sending' ? 'is-sending' : ''} ${testState === 'sent' ? 'is-sent' : ''}`}
          onClick={() => { void handleTest(); }}
          disabled={saving || testing || savingReactivation || loading || refreshing || !notificationDataReady || !digestCovered || !digestSendReady || emailService === 'down' || testState === 'sent'}
          aria-live="polite"
          aria-busy={testState === 'sending'}
        >
          <AnimatePresence mode="wait" initial={false}>
            {testState === 'sending' ? (
              <motion.span key="sending" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>
                <CircleNotch className="email-notification-test-spinner" size={16} /> {'Sending…'}
              </motion.span>
            ) : testState === 'sent' ? (
              <motion.span key="sent" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                <CheckCircle size={17} /> {'Sent'}
              </motion.span>
            ) : (
              <motion.span key="idle" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>
                <PaperPlaneTilt size={16} /> {'Send test'}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
        <button type="button" className="email-notification-save" onClick={() => { void handleSave(); }} disabled={saving || testing || savingReactivation || loading || refreshing || !notificationDataReady || (draft.enabled && (emailService === 'down' || !digestCovered || !digestSendReady))}>
          {saving
            ? ('Saving...')
            : ('Save changes')}
        </button>
      </footer>
    </>
  );

  if (isPhone) {
    return (
      <Drawer open={isOpen} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
        <DrawerContent className="settings-sheet email-notification-sheet" overlayClassName="settings-sheet-backdrop">
          <DrawerHandle />
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }} modal>
      <DialogContent
        className="email-notification-modal"
        overlayClassName="email-notification-backdrop"
        closeLabel={'Close'}
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}
