import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext.tsx';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import InstitutionPill from './InstitutionPill.tsx';
import InstitutionServices from './InstitutionServices.tsx';
import GoogleMark from '../Public/GoogleMark.tsx';
import './Institution.css';

const COPY = {
  email: 'University email',
  placeholder: 'name@university.edu',
  hint: 'When you continue, Google opens so you can sign in with that account. PaperTok keeps the institution, not the address.',
  submit: 'Continue with Google',
  submitting: 'Verifying…',
  linked: name => `Verified with ${name}.`,
  unlink: 'Unlink',
  unlinking: 'Unlinking…',
  linkedNow: 'Institution linked.',
  unlinked: 'Institution unlinked.',
};

/**
 * The one place an institution gets linked or unlinked, used from the
 * onboarding's last step and from Settings. `idPrefix` keeps the field ids
 * unique when the two could share a page.
 *
 * Settings uses it as it is: the field and its own Google button. A caller
 * that draws the submit itself (the onboarding's primary, in the page's foot)
 * passes `showSubmit={false}` and a `formId` for its button's `form`, owns
 * the address through `email` / `onEmailChange` so it can tell whether one is
 * typed, and hears `onBusyChange` to say "Verifying…" while Google is open.
 * There, `linkedNote` adds a sentence after "Verified with …" once linked.
 */
export default function InstitutionLink({
  idPrefix = 'institution',
  formId,
  showSubmit = true,
  email: controlledEmail,
  onEmailChange,
  onBusyChange,
  linkedNote,
}) {
  const { institution, linkInstitution, unlinkInstitution } = useAuth();
  const [ownEmail, setOwnEmail] = useState('');
  const controlled = controlledEmail !== undefined;
  const email = controlled ? controlledEmail : ownEmail;
  const setEmail = controlled ? onEmailChange : setOwnEmail;
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const [feedback, setFeedback] = useState(null);
  // Linking swaps the form for the linked row and unlinking swaps it back, so
  // the control that had focus is gone either way. Focus lands on the control
  // that continues the task: Unlink after a link, the field after an unlink.
  const pendingFocus = useRef(null);
  const inputRef = useRef(null);
  const unlinkRef = useRef(null);
  useEffect(() => {
    if (pendingFocus.current === 'unlink' && institution) unlinkRef.current?.focus();
    if (pendingFocus.current === 'input' && !institution) inputRef.current?.focus();
    pendingFocus.current = null;
  }, [institution]);
  const inputId = `${idPrefix}-email`;
  const hintId = `${idPrefix}-hint`;
  const feedbackId = `${idPrefix}-feedback`;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    pendingFocus.current = 'unlink';
    try {
      await linkInstitution(email);
      setEmail('');
      setFeedback({ tone: 'success', text: COPY.linkedNow });
    } catch (error) {
      // Closing Google's window is a decision, not a failure to report.
      if (error?.code === 'auth/popup-closed-by-user' || error?.code === 'auth/cancelled-popup-request') {
        setFeedback(null);
      } else {
        if (!String(error?.code || '').startsWith('INSTITUTION_')) console.error('Error linking institution:', error);
        setFeedback({ tone: 'error', text: getUiErrorMessage(error, 'INSTITUTION_LINK_FAILED') });
      }
      pendingFocus.current = null;
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      pendingFocus.current = 'input';
      await unlinkInstitution();
      setFeedback({ tone: 'success', text: COPY.unlinked });
    } catch (error) {
      pendingFocus.current = null;
      console.error('Error unlinking institution:', error);
      setFeedback({ tone: 'error', text: getUiErrorMessage(error, 'INSTITUTION_LINK_FAILED') });
    } finally {
      setBusy(false);
    }
  };

  const feedbackNode = (
    <p
      id={feedbackId}
      className={`institution-link-feedback${feedback ? ` is-${feedback.tone}` : ''}`}
      role={feedback?.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {feedback?.text || ''}
    </p>
  );

  if (institution) {
    return (
      <div className="institution-link is-linked">
        <InstitutionPill institution={institution} />
        <p className="institution-link-copy">{COPY.linked(institution.name)}{linkedNote ? ` ${linkedNote}` : ''}</p>
        <Button ref={unlinkRef} type="button" variant="outline" size="sm" onClick={handleUnlink} disabled={busy}>
          {busy ? COPY.unlinking : COPY.unlink}
        </Button>
        <InstitutionServices institution={institution} />
        {feedbackNode}
      </div>
    );
  }

  return (
    // Nothing is disabled while Google is open: a disabled control drops the
    // focus it had, and the error that may come back would land on nobody.
    <form id={formId} className="institution-link" onSubmit={handleSubmit} noValidate aria-busy={busy || undefined}>
      <Label htmlFor={inputId}>{COPY.email}</Label>
      <div className="institution-link-row">
        <Input
          ref={inputRef}
          id={inputId}
          className="institution-link-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck="false"
          placeholder={COPY.placeholder}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (feedback?.tone === 'error') setFeedback(null);
          }}
          readOnly={busy}
          required
          aria-required="true"
          aria-invalid={feedback?.tone === 'error' ? 'true' : undefined}
          aria-describedby={feedback?.tone === 'error' ? `${hintId} ${feedbackId}` : hintId}
        />
        {showSubmit && (
          <Button type="submit" variant="outline" className="institution-link-submit" aria-disabled={busy || undefined}>
            {busy ? <span className="institution-link-spinner" aria-hidden="true" /> : <GoogleMark size={16} />}
            {busy ? COPY.submitting : COPY.submit}
          </Button>
        )}
      </div>
      <p id={hintId} className="institution-link-hint">{COPY.hint}</p>
      {feedbackNode}
    </form>
  );
}
