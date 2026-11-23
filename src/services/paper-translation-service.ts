import { authenticatedWorkerFetch, workerSourceUrl, WorkerApiAuthError } from './worker-api-client.ts';
import { withEnforcedDeadline } from '../utils/request-deadline.ts';
import { parseTranslationText, type PaperTranslation, type PaperTranslationRequest } from '../utils/paper-translation-contract.ts';

type TranslationResponse =
  | { translation: PaperTranslation }
  | { code: string; scope?: unknown };

export async function requestPaperTranslation(input: PaperTranslationRequest, signal: AbortSignal): Promise<TranslationResponse> {
  const url = workerSourceUrl('/ai/translate');
  if (!url) return { code: 'AI_NOT_CONFIGURED' } as const;
  const options = withEnforcedDeadline({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
    abortTokenWait: true,
  }, 25_000);
  try {
    const response = await authenticatedWorkerFetch(url, options);
    if (response.status === 401) return { code: 'AI_AUTH_REQUIRED' } as const;
    if (response.status === 404 || response.status === 405) return { code: 'AI_NOT_CONFIGURED' } as const;
    const payload = await response.json() as { code?: unknown; quota?: { scope?: unknown }; language?: unknown } | null;
    if (!response.ok) {
      return {
        code: typeof payload?.code === 'string' ? payload.code : 'AI_UNAVAILABLE',
        scope: payload?.quota?.scope,
      };
    }
    const text = parseTranslationText(payload);
    if (!text || payload?.language !== input.language) return { code: 'AI_INVALID_RESPONSE' } as const;
    return { translation: { ...text, language: input.language } };
  } catch (error) {
    if (error instanceof WorkerApiAuthError
      || (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('auth/'))) {
      return { code: 'AI_AUTH_REQUIRED' } as const;
    }
    return { code: options.signal?.aborted && !signal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE' } as const;
  }
}
