import { useEffect, useMemo, useRef, useState } from 'react';
import type { Paper } from '../models/paper.ts';
import { requestPaperTranslation } from '../services/paper-translation-service.ts';
import { preferredTranslationLanguage, rememberTranslationLanguage, translationSource } from '../utils/paper-translation.ts';
import type { PaperTranslation, TranslationLanguage } from '../utils/paper-translation-contract.ts';

type Session = {
  scope: string;
  translation?: PaperTranslation;
  showing?: boolean;
  pending?: boolean;
  error?: string;
};

function translationErrorMessage(code: string, scope: unknown) {
  switch (code) {
    case 'AI_QUOTA_EXHAUSTED':
      return scope === 'user' ? 'You’ve used today’s translations. Try again after midnight UTC.' : 'Translation is paused until midnight UTC.';
    case 'AI_NOT_CONFIGURED':
      return 'Translation isn’t available right now.';
    case 'AI_INVALID_PAPER':
      return 'This title and abstract couldn’t be matched to arXiv.';
    case 'AI_EMPTY_RESPONSE':
      return 'This abstract couldn’t be translated.';
    case 'AI_TIMEOUT':
      return 'Translation timed out. Try again.';
    default:
      return 'Couldn’t translate this abstract. Try again.';
  }
}

export function usePaperTranslation(paper: Paper, uid: string | undefined, enabled: boolean, onAuthRequired: () => void) {
  const source = useMemo(() => enabled ? translationSource(paper) : null, [enabled, paper]);
  const scope = useMemo(() => JSON.stringify([uid, source]), [uid, source]);
  const [session, setSession] = useState<Session>({ scope });
  const pendingRequest = useRef<{ scope: string; controller: AbortController } | null>(null);
  const current: Session = session.scope === scope ? session : { scope };
  if (session.scope !== scope) setSession({ scope });

  useEffect(() => () => {
    if (pendingRequest.current?.scope === scope) {
      pendingRequest.current.controller.abort();
      pendingRequest.current = null;
    }
  }, [scope]);

  function chooseLanguage() {
    if (!uid) return '';
    try {
      return preferredTranslationLanguage(uid, navigator.languages, localStorage);
    } catch {
      return preferredTranslationLanguage(uid, navigator.languages, undefined);
    }
  }

  async function translate(language: TranslationLanguage) {
    if (!uid || !source || pendingRequest.current) return;
    if (current.translation?.language === language) {
      setSession({ ...current, showing: true, error: undefined });
      return;
    }
    try {
      rememberTranslationLanguage(uid, language, localStorage);
    } catch {
      // Browser storage may be blocked. Translation still works for this card.
    }
    const controller = new AbortController();
    pendingRequest.current = { scope, controller };
    setSession({ ...current, pending: true, error: undefined });
    const result = await requestPaperTranslation({ ...source, language }, controller.signal);
    if (controller.signal.aborted) return;
    pendingRequest.current = null;
    if ('translation' in result) {
      setSession({ scope, translation: result.translation, showing: true });
    } else {
      setSession({
        ...current,
        pending: false,
        error: result.code === 'AI_AUTH_REQUIRED' ? undefined : translationErrorMessage(result.code, result.scope),
      });
      if (result.code === 'AI_AUTH_REQUIRED') onAuthRequired();
    }
  }

  return {
    scope,
    eligible: Boolean(source),
    signedIn: Boolean(uid),
    current,
    chooseLanguage,
    translate,
    showOriginal: () => setSession({ ...current, error: undefined, showing: false }),
  };
}
