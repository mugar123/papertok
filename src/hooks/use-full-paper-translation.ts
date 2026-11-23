import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FullText, Block } from '../utils/full-text.ts';
import { applyTranslatedPassages, planFullPaperTranslation } from '../utils/full-paper-translation.ts';
import { requestFullPaperTranslation } from '../services/full-paper-translation-service.ts';
import { auth } from '../services/firebase.ts';
import type { TranslationLanguage } from '../utils/paper-translation-contract.ts';

type Session = {
  language: TranslationLanguage;
  blocks: Map<Block, Block>;
  completed: number;
  pending: boolean;
  showing: boolean;
  message?: string;
  unavailable?: boolean;
};

function failureMessage(code: string, scope: unknown) {
  switch (code) {
    case 'AI_QUOTA_EXHAUSTED':
      return scope === 'user'
        ? 'You’ve used today’s five full-paper translations. Try again after midnight UTC.'
        : 'Full-paper translation has reached its daily limit. Try again after midnight UTC.';
    case 'AI_BUSY':
      return 'Full-paper translation is busy. Try again in a minute.';
    case 'AI_NOT_CONFIGURED':
      return 'Full-paper translation is currently unavailable.';
    case 'AI_INVALID_PAPER':
      return 'The paper text couldn’t be matched to arXiv. Reload the page and try again.';
    case 'AI_AUTH_REQUIRED':
      return 'Sign in to translate the full paper.';
    case 'AI_TIMEOUT':
      return 'Full-paper translation timed out.';
    default:
      return 'The full paper couldn’t be translated.';
  }
}

export function useFullPaperTranslation(doc: FullText | undefined, query: string, uid: string) {
  const plan = useMemo(() => doc && query ? planFullPaperTranslation(doc) : null, [doc, query]);
  const scope = useMemo(() => ({ plan, uid }), [plan, uid]);
  const [saved, setSaved] = useState<{ scope: typeof scope; session: Session | null }>({ scope, session: null });
  if (saved.scope !== scope) setSaved({ scope, session: null });
  const session = saved.scope === scope ? saved.session : null;
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => {
    active.current?.abort();
    active.current = null;
  }, [scope]);

  async function translate(language: TranslationLanguage) {
    if (!scope.plan || !uid || auth.currentUser?.uid !== uid || active.current) return;
    const { source, chunks } = scope.plan;
    if (session?.language === language && session.completed === chunks.length && !session.message) {
      setSaved({ scope, session: { ...session, showing: true } });
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    const initial: Session = { language, blocks: new Map(), completed: 0, pending: true, showing: true };
    const current = () => active.current === controller && auth.currentUser?.uid === uid;
    setSaved({ scope, session: initial });
    const failure = await requestFullPaperTranslation({ query, language, chunks: source, uid }, controller.signal, (index, segments) => {
      if (!current()) return;
      const translated = applyTranslatedPassages(chunks[index], segments, language);
      setSaved(previous => previous.scope === scope && previous.session?.pending ? {
        scope,
        session: {
          ...previous.session,
          blocks: new Map([...previous.session.blocks, ...translated]),
          completed: index + 1,
        },
      } : previous);
    });
    if (!current()) return;
    active.current = null;
    const message = failure ? failureMessage(failure.code, failure.scope) : undefined;
    setSaved(previous => previous.scope === scope && previous.session?.pending
      ? { scope, session: { ...previous.session, pending: false, message, unavailable: failure?.code === 'AI_NOT_CONFIGURED' } }
      : previous);
  }

  function cancel() {
    active.current?.abort();
    active.current = null;
    if (session) setSaved({ scope, session: { ...session, pending: false, showing: false, completed: 0, blocks: new Map(), message: 'Full-paper translation cancelled.' } });
  }

  function toggleOriginal() {
    setSaved(previous => previous.scope === scope && previous.session
      ? { scope, session: { ...previous.session, showing: !previous.session.showing } }
      : previous);
  }

  return { session, total: plan?.chunks.length ?? 0, translate, cancel, toggleOriginal };
}
