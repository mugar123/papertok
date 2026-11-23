import { auth } from './firebase.ts';
import { authenticatedWorkerFetch, workerSourceUrl, WorkerApiAuthError } from './worker-api-client.ts';
import { withEnforcedDeadline } from '../utils/request-deadline.ts';
import {
  fullPaperTranslationRevision,
  PAPER_TRANSLATION_DEADLINE_MS,
  parseTranslatedChunk,
} from '../utils/full-paper-translation-contract.ts';
import type { TranslationLanguage } from '../utils/paper-translation-contract.ts';

type Failure = { code: string; scope?: unknown };

export async function requestFullPaperTranslation(
  { query, language, chunks, uid }: { query: string; language: TranslationLanguage; chunks: string[][]; uid: string },
  signal: AbortSignal,
  onChunk: (index: number, segments: string[]) => void,
): Promise<Failure | null> {
  const url = workerSourceUrl('/ai/translate-paper');
  if (!url) return { code: 'AI_NOT_CONFIGURED' };
  const options = withEnforcedDeadline({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    abortTokenWait: true,
  }, PAPER_TRANSLATION_DEADLINE_MS + 2_000);
  try {
    const fingerprint = await fullPaperTranslationRevision(chunks);
    if (auth.currentUser?.uid !== uid) return { code: 'AI_AUTH_REQUIRED' };
    const response = await authenticatedWorkerFetch(url, { ...options, body: JSON.stringify({ query, language, fingerprint }) });
    if (response.status === 401) return { code: 'AI_AUTH_REQUIRED' };
    if (response.status === 404 || response.status === 405) return { code: 'AI_NOT_CONFIGURED' };
    if (!response.ok) {
      const payload = await response.json() as { code?: unknown; quota?: { scope?: unknown } } | null;
      return { code: typeof payload?.code === 'string' ? payload.code : 'AI_UNAVAILABLE', scope: payload?.quota?.scope };
    }
    if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
      return { code: 'AI_INVALID_RESPONSE' };
    }
    return await readPaperTranslation(response.body, chunks, onChunk);
  } catch (error) {
    if (error instanceof WorkerApiAuthError) return { code: 'AI_AUTH_REQUIRED' };
    return { code: options.signal.reason?.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE' };
  }
}

async function readPaperTranslation(
  body: ReadableStream<Uint8Array>,
  chunks: string[][],
  onChunk: (index: number, segments: string[]) => void,
): Promise<Failure | null> {
  const reader = body.pipeThrough(new TextDecoderStream('utf-8', { fatal: true })).getReader();
  let pending = '';
  let completed = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { code: 'AI_INVALID_RESPONSE' };
      pending += value;
      let newline = pending.indexOf('\n');
      while (newline >= 0 && newline <= 31_000) {
        const event: unknown = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (!event || typeof event !== 'object' || !('type' in event)) return { code: 'AI_INVALID_RESPONSE' };
        if (event.type === 'error' && 'code' in event && typeof event.code === 'string') return { code: event.code };
        if (event.type === 'done' && 'count' in event && event.count === chunks.length && completed === chunks.length) return null;
        if (event.type !== 'chunk' || !('index' in event) || event.index !== completed
          || !('segments' in event) || completed >= chunks.length) return { code: 'AI_INVALID_RESPONSE' };
        const translated = parseTranslatedChunk(event.segments, chunks[completed].length);
        if (!translated) return { code: 'AI_INVALID_RESPONSE' };
        onChunk(completed++, translated);
        newline = pending.indexOf('\n');
      }
      if (pending.length > 31_000) return { code: 'AI_INVALID_RESPONSE' };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
