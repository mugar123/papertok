import { useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { EnvelopeSimple } from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';
import NudgePanel from './nudge-panel.tsx';
import { PRIVACY_NOTICE_COPY, type VisitNotice } from './use-visit-notice.ts';

// Renders what useVisitNotice chose: the email nudge in its corner panel, and
// the status message for the privacy notice, which the feed renders above its
// cards.

const COPY = {
  en: {
    dismiss: 'Dismiss and do not show again',
    'email-down': {
      'not-configured': {
        title: 'Email updates are paused',
        body: 'The service is not connected yet, so no digest will go out.',
      },
      unavailable: {
        title: 'Email updates are paused',
        body: 'The email service is not responding right now, so digests are not going out.',
      },
      cta: 'Settings',
    },
  },
};

export default function NudgeHost({ visit }: { visit: VisitNotice }) {
  const navigate = useNavigate();
  const { onScreen, statusSet, emailProblem, closeNudge } = visit;

  const handleSettings = useCallback(() => {
    closeNudge('email-down');
    void navigate('/settings/notifications');
  }, [closeNudge, navigate]);

  const copy = COPY.en;
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;

  return (
    <>
    {/* Always mounted: a live region speaks when its text changes, and one that
        arrives already holding text is often not read. It says only that the
        notice is there; the summary is read once, in the notice. */}
    <p className="visually-hidden" role="status">
      {statusSet ? `${PRIVACY_NOTICE_COPY.title}. ${PRIVACY_NOTICE_COPY.announced}` : ''}
    </p>
    <AnimatePresence>
      {onScreen === 'email-down' && emailCopy && (
        <NudgePanel
          key="nudge-email-down"
          icon={<EnvelopeSimple size={19} />}
          title={emailCopy.title}
          body={emailCopy.body}
          action={{ label: copy['email-down'].cta, onClick: handleSettings }}
          dismissLabel={copy.dismiss}
          onDismiss={() => closeNudge('email-down')}
        />
      )}
    </AnimatePresence>
    </>
  );
}
