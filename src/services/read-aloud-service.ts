import { authenticatedWorkerFetch } from './worker-api-client.ts';

const PARAGRAPH_TIMEOUT_MS = 40_000;

export class ReadAloudError extends Error {
  declare code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ReadAloudError';
    this.code = code;
  }
}

/**
 * One paragraph spoken by PaperTok's voice, as MP3. With `storedOnly` the
 * Worker answers only from audio already made, refusing with
 * `AI_AUDIO_NOT_STORED` rather than spending credits.
 */
export async function fetchParagraphAudio(text: string, { signal, storedOnly = false }: { signal?: AbortSignal; storedOnly?: boolean } = {}) {
  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) throw new ReadAloudError('AI_NOT_CONFIGURED');
  let response: Response;
  try {
    response = await authenticatedWorkerFetch(`${apiBase}/tts/paragraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(storedOnly ? { text, storedOnly } : { text }),
      signal,
    }, PARAGRAPH_TIMEOUT_MS);
  } catch (error) {
    throw new ReadAloudError((error as { name?: string } | null)?.name === 'WorkerApiAuthError' ? 'AI_AUTH_REQUIRED' : 'AI_UNAVAILABLE');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    throw new ReadAloudError(typeof body?.code === 'string' ? body.code : 'AI_UNAVAILABLE');
  }
  return response.blob();
}

/**
 * ElevenLabs' character timings of a paragraph whose audio exists, or null
 * when there are none (Cartesia's audio, or timings that were not stored).
 * Only reads what is stored: it never spends credits.
 */
export async function fetchParagraphTimings(text: string, { signal }: { signal?: AbortSignal } = {}) {
  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) return null;
  const response = await authenticatedWorkerFetch(`${apiBase}/tts/paragraph`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, timings: true }),
    signal,
  }, PARAGRAPH_TIMEOUT_MS).catch(() => null);
  if (!response?.ok || !response.headers.get('content-type')?.startsWith('application/json')) return null;
  const body = await response.json().catch(() => null) as { characters?: unknown; character_start_times_seconds?: unknown } | null;
  const { characters, character_start_times_seconds: starts } = body ?? {};
  return Array.isArray(characters) && Array.isArray(starts) && characters.length === starts.length
    && characters.every((character: unknown): character is string => typeof character === 'string')
    && starts.every((start: unknown): start is number => typeof start === 'number' && Number.isFinite(start))
    ? { characters, character_start_times_seconds: starts }
    : null;
}
