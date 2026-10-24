import { useEffect, useId, useRef, useState } from 'react';
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
import { useAuth } from '../../context/AuthContext.tsx';
import { useEmailNotifications } from '../../context/EmailNotificationsContext.tsx';
import { useLanguage } from '../../context/LanguageContext.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { Label } from '../ui/label.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { Switch } from '../ui/switch.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import '../Settings/SettingsSheet.css';
import './EmailNotificationModal.css';

const ERROR_COPY = {
  en: {
    EMAIL_NOT_CONFIGURED: 'Email updates have not been configured yet.',
    EMAIL_AUTH_REQUIRED: 'Sign in again to configure email updates.',
    EMAIL_ADDRESS_NOT_VERIFIED: 'Confirm your email address with your sign-in provider before enabling email updates.',
    EMAIL_PROVIDER_AUTH_FAILED: 'The email provider rejected the configured credential.',
    EMAIL_SENDER_NOT_VERIFIED: 'The Brevo sender has not been verified yet.',
    EMAIL_PROVIDER_LIMIT: 'The sending limit has temporarily been reached.',
    EMAIL_TEST_RATE_LIMIT: 'Wait one minute before sending another test.',
    EMAIL_TEST_RECIPIENT_RESTRICTED: 'Resend is in test mode and can only send to the account owner. A verified domain is required for other recipients.',
    EMAIL_DATA_LOADING: 'We are still loading what you follow. Try again in a few seconds.',
    EMAIL_FOLLOWS_REQUIRED: 'Follow at least one topic, author, institution, or project before enabling emails.',
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
  const { emailDigestPending } = useAuth();
  const enabledId = useId();
  const countId = useId();
  const {
    preferences,
    health,
    loading,
    saving,
    testing,
    notificationDataReady,
    hasFollows,
    savePreferences,
    sendTest,
  } = useEmailNotifications();
  const [draft, setDraft] = useState(preferences);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testState, setTestState] = useState('idle');
  const preferencesRef = useRef(preferences);
  const testFeedbackTimerRef = useRef<number | null>(null);
  const isPhone = useIsPhone();

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  // Escape, the scrim and the focus trap are the Dialog's own; what is left
  // here is the draft, reset from the saved preferences on every opening.
  useEffect(() => {
    if (!isOpen) return undefined;
    const timeoutId = setTimeout(() => {
      setDraft(preferencesRef.current);
      setFeedback(null);
      setTestState('idle');
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      clearTimeout(testFeedbackTimerRef.current!);
    };
  }, [isOpen]);

  const handleSave = async () => {
    setFeedback(null);
    try {
      await savePreferences(draft);
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
      setDraft(saved);
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

  const toggleDisabled = loading || (!health.available && !draft.enabled) || (!hasFollows && !draft.enabled);
  const optionsDisabled = !draft.enabled || loading;

  // On a phone the same content is a bottom sheet, like the other sheets
  // Settings opens; the handle and a swipe take the place of the X.
  const Title = isPhone ? DrawerTitle : DialogTitle;
  const Description = isPhone ? DrawerDescription : DialogDescription;
  const content = (
    <>
      <header>
        <div className={`email-notification-icon${!loading && !health.available ? ' is-down' : ''}`}><Envelope size={20} aria-hidden="true" /></div>
        <div>
          <Title>{'Email updates'}</Title>
          <Description>{'Receive a weekly digest even when PaperTok is closed.'}</Description>
        </div>
      </header>

      <div className="email-notification-body" data-base-ui-swipe-ignore="">
        {!loading && !health.available && (
          <div className="email-notification-provider-warning">
            <strong>{'Sending requires configuration'}</strong>
            <span>{health.code === 'EMAIL_PROVIDER_AUTH_FAILED'
              ? ('The email provider did not accept the saved credential.')
              : health.code === 'EMAIL_SENDER_NOT_VERIFIED'
                ? ('Brevo does not yet recognize the configured sender as active.')
                : ('The email provider is not available right now.')}</span>
          </div>
        )}
        {!loading && health.available && health.provider === 'resend' && health.senderMode === 'resend-test' && (
          <div className="email-notification-provider-warning is-info">
            <strong>{'Resend test mode'}</strong>
            <span>{'Without a verified domain, Resend will only deliver email to the account owner.'}</span>
          </div>
        )}
        {!loading && health.available && health.provider === 'resend' && health.permissionLimited && health.senderMode !== 'resend-test' && (
          <div className="email-notification-provider-warning is-info">
            <strong>{'Restricted sending key'}</strong>
            <span>{'The Resend credential only has sending permission, so the domain status cannot be checked here. Sending still works normally.'}</span>
          </div>
        )}
        {!loading && notificationDataReady && !hasFollows && (
          <div className="email-notification-provider-warning is-info">
            <strong>{'Nothing followed yet'}</strong>
            <span>{emailDigestPending
              ? 'You asked for the digest when you joined. It starts on its own with your first follow: a topic, author, institution, or project.'
              : <><Link to="/settings/following" onClick={onClose}>{'Follow something'}</Link>{' so PaperTok can send you relevant papers.'}</>}</span>
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
            onCheckedChange={checked => setDraft(current => ({ ...current, enabled: checked }))}
            disabled={toggleDisabled}
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
              onValueChange={value => setDraft(current => ({ ...current, maxPapers: Number(value) }))}
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
          {feedback && (
            <motion.p className={`email-notification-feedback is-${feedback.type}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.14 } }}>
              {feedback.type === 'success' && <Check size={15} />} {feedback.text}
            </motion.p>
          )}
          </AnimatePresence>
        </div>

        <div className="email-notification-schedule">
          <Clock size={16} aria-hidden="true" />
          <span>{'Every Monday morning, only when there are updates.'}</span>
        </div>
      </div>

      <footer>
        <button
          type="button"
          className={`email-notification-test ${testState === 'sending' ? 'is-sending' : ''} ${testState === 'sent' ? 'is-sent' : ''}`}
          onClick={handleTest}
          disabled={saving || testing || loading || !notificationDataReady || !hasFollows || !health.available || testState === 'sent'}
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
        <button type="button" className="email-notification-save" onClick={handleSave} disabled={saving || testing || loading || !notificationDataReady || (draft.enabled && (!health.available || !hasFollows))}>
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
