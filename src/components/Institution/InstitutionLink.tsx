import type { FormEvent } from 'react';
type InstitutionLinkProps = {
  idPrefix?: string; formId?: string; showSubmit?: boolean;
  onBusyChange?: (busy: boolean) => void; linkedNote?: string;
} & ({ email: string; onEmailChange: (email: string) => void } | { email?: undefined; onEmailChange?: undefined });
import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext.tsx';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import InstitutionPill from './InstitutionPill.tsx';
import InstitutionServices from './InstitutionServices.tsx';
import { cancelInstitutionVerification, pendingInstitutionVerification, sendInstitutionVerification, needsUniversityProof } from '../../services/institutionService.ts';
import './Institution.css';

const COPY = {
  email: 'University email',
  placeholder: 'name@university.edu',
  hint: 'We will email a verification link. Open it in this browser while signed into this PaperTok account.',
  submit: 'Verify university email',
  submitting: 'Verifying…',
  linked: (name: string) => `Verified with ${name}.`,
  unlink: 'Unlink',
  unlinking: 'Unlinking…',
  linkedNow: 'Institution linked.',
  unlinked: 'Institution unlinked.',
};

/** Shared by Settings and onboarding, whose primary can submit this form. */
export default function InstitutionLink({
  idPrefix = 'institution',
  formId,
  showSubmit = true,
  email: controlledEmail,
  onEmailChange,
  onBusyChange,
  linkedNote,
}: InstitutionLinkProps) {
  const { institution, linkInstitution, unlinkInstitution } = useAuth();
  const [ownEmail, setOwnEmail] = useState('');
  const controlled = controlledEmail !== undefined;
  const email = controlled ? controlledEmail : ownEmail;
  const setEmail = controlled ? onEmailChange : setOwnEmail;
  const [busy, setOwnBusy] = useState(false);
  const setBusy = (next: boolean) => { setOwnBusy(next); onBusyChange?.(next); };
  const [pending, setPending] = useState(() => pendingInstitutionVerification());
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  // The pill is pinned only when the link lands while this form is on screen,
  // not each time the window opens on an account that was already linked.
  const [wasLinked, setWasLinked] = useState(Boolean(institution));
  const [justLinked, setJustLinked] = useState(false);
  if (wasLinked !== Boolean(institution)) {
    setWasLinked(Boolean(institution));
    setJustLinked(Boolean(institution));
  }
  // Linking swaps the form for the linked row and unlinking swaps it back, so
  // the control that had focus is gone either way. Focus lands on the control
  // that continues the task: Unlink after a link, the field after an unlink.
  const pendingFocus = useRef<'input' | 'unlink' | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const unlinkRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (pendingFocus.current === 'unlink' && institution) unlinkRef.current?.focus();
    if (pendingFocus.current === 'input' && !institution) inputRef.current?.focus();
    pendingFocus.current = null;
  }, [institution]);
  const inputId = `${idPrefix}-email`;
  const hintId = `${idPrefix}-hint`;
  const feedbackId = `${idPrefix}-feedback`;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || pending) return;
    setBusy(true);
    setFeedback(null);
    pendingFocus.current = 'unlink';
    try {
      if (needsUniversityProof(email)) {
        await sendInstitutionVerification(email);
        setPending(pendingInstitutionVerification());
        setEmail!('');
        setFeedback({ tone: 'success', text: 'Check your university inbox. Continue in the tab opened by the email.' });
        pendingFocus.current = null;
      } else {
        await linkInstitution(email);
        setEmail!('');
        setFeedback({ tone: 'success', text: COPY.linkedNow });
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: getUiErrorMessage(error, 'INSTITUTION_LINK_FAILED') });
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

  const feedbackText = feedback?.text || (pending ? 'Check your university inbox. Continue in the tab opened by the email.' : '');
  // The region stays mounted so each message is announced; the keyed span
  // opens again whenever the message changes.
  const feedbackNode = (
    <p
      id={feedbackId}
      className={`institution-link-feedback${feedback ? ` is-${feedback.tone}` : ''}`}
      role={feedback?.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {feedbackText && <span key={feedbackText} className="institution-link-reveal"><span>{feedbackText}</span></span>}
    </p>
  );

  if (institution) {
    return (
      <div className={`institution-link is-linked${justLinked ? ' is-just-linked' : ''}`}>
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
    <form id={formId} className="institution-link" onSubmit={handleSubmit} noValidate aria-busy={busy || undefined}>
      <Label htmlFor={inputId}>{COPY.email}</Label>
      <div className="institution-link-field">
        <Input
          ref={inputRef}
          id={inputId}
          className="institution-link-input"
          type="email"
          inputMode="email"
          enterKeyHint="go"
          autoComplete="email"
          spellCheck="false"
          placeholder={COPY.placeholder}
          value={pending?.email ?? email}
          onChange={(event) => {
            setEmail!(event.target.value);
            if (feedback?.tone === 'error') setFeedback(null);
          }}
          readOnly={busy || Boolean(pending)}
          required
          aria-required="true"
          aria-invalid={feedback?.tone === 'error' ? 'true' : undefined}
          aria-describedby={feedback?.tone === 'error' ? `${hintId} ${feedbackId}` : hintId}
        />
        {showSubmit && (
          <Button
            type="submit"
            size="icon-sm"
            className="institution-link-submit"
            aria-label={busy ? COPY.submitting : COPY.submit}
            title={COPY.submit}
            disabled={Boolean(pending)}
            focusableWhenDisabled
            aria-disabled={busy || Boolean(pending) || undefined}
          >
            {busy ? <span className="institution-link-spinner" aria-hidden="true" /> : <ArrowRight size={16} weight="bold" aria-hidden="true" />}
          </Button>
        )}
      </div>
      {pending && (
        <div className="institution-link-reveal">
          <div>
            <Button type="button" variant="outline" className="w-full" onClick={() => {
              cancelInstitutionVerification();
              setPending(null);
              setFeedback(null);
              inputRef.current?.focus();
            }}>Cancel verification</Button>
          </div>
        </div>
      )}
      <p id={hintId} className="institution-link-hint">{COPY.hint}</p>
      {feedbackNode}
    </form>
  );
}
