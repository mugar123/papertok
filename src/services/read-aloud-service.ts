import { authenticatedWorkerFetch } from './worker-api-client.ts';

const PARAGRAPH_TIMEOUT_MS = 40_000;
/** Papers asked about in one request, the most the Worker answers for (`/tts/papers`). */
const VOICED_PAGE = 60;

export class ReadAloudError extends Error {
  declare code: string;
  /** Whose allowance a refusal spent: `user` (the account's papers or characters), `global` or `provider`. */
  declare scope?: string;
  constructor(code: string, scope?: string) {
    super(code);
    this.name = 'ReadAloudError';
    this.code = code;
    this.scope = scope;
  }
}

function postToVoice(body: unknown, signal?: AbortSignal) {
  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) return Promise.resolve(null);
  return authenticatedWorkerFetch(`${apiBase}/tts/papers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }, PARAGRAPH_TIMEOUT_MS).catch(() => null);
}

/**
 * Hands the Worker the name of every paragraph's audio, so it marks the paper as voiced once it
 * finds them all stored, and the feed can show it.
 */
export async function markPaperVoiced(paperId: string, audio: string[]) {
  const response = await postToVoice({ paperId, voiced: true, audio });
  const body = response?.ok ? await response.json().catch(() => null) as { voiced?: unknown } | null : null;
  if (body?.voiced === true) noteVoiced([paperId]);
}

const voiced = new Map<string, boolean>();
const asked = new Set<string>();
const voicedChanges = new EventTarget();
let asking: ReturnType<typeof setTimeout> | null = null;

function noteVoiced(ids: string[], all = ids) {
  for (const id of all) voiced.set(id, ids.includes(id));
  voicedChanges.dispatchEvent(new Event('change'));
}

export function subscribeVoicedPapers(listener: () => void) {
  voicedChanges.addEventListener('change', listener);
  return () => voicedChanges.removeEventListener('change', listener);
}

/** Whether the paper has PaperTok's audio for every paragraph, as far as this page has asked. */
export const isPaperVoiced = (paperId: string) => voiced.get(paperId) === true;

/**
 * Asks once per page load whether a paper has PaperTok's audio, gathering the cards that ask in the
 * same moment into one request. A failed request leaves them unknown, which shows nothing.
 */
export function askPaperVoiced(paperId: string) {
  if (!paperId || voiced.has(paperId) || asked.has(paperId)) return;
  asked.add(paperId);
  asking ??= setTimeout(() => {
    asking = null;
    const ids = [...asked].filter(id => !voiced.has(id));
    for (let start = 0; start < ids.length; start += VOICED_PAGE) {
      const page = ids.slice(start, start + VOICED_PAGE);
      void postToVoice({ papers: page })
        .then(response => (response?.ok ? response.json() as Promise<{ voiced?: unknown }> : null))
        .then((body) => {
          if (Array.isArray(body?.voiced)) noteVoiced(body.voiced.filter((id): id is string => typeof id === 'string'), page);
          else for (const id of page) asked.delete(id);
        }, () => { for (const id of page) asked.delete(id); });
    }
  }, 50);
}

/**
 * How many new papers the account may still have read in PaperTok's voice today. Null when
 * unknown, and for an account whose AI is unlimited, so neither shows a count.
 */
export async function fetchVoiceUsage({ signal }: { signal?: AbortSignal } = {}) {
  const response = await postToVoice({ usage: true }, signal);
  const body = response?.ok ? await response.json().catch(() => null) as { papersLeft?: unknown; dailyPapers?: unknown } | null : null;
  const { papersLeft, dailyPapers } = body ?? {};
  return Number.isInteger(papersLeft) && Number.isInteger(dailyPapers) ? { papersLeft: papersLeft as number, dailyPapers: dailyPapers as number } : null;
}

/**
 * One paragraph spoken by PaperTok's voice, as MP3, with the name the Worker
 * stores it under. With `storedOnly` the Worker answers only from audio already
 * made, refusing with `AI_AUDIO_NOT_STORED` rather than spending credits.
 */
export async function fetchParagraphAudio(text: string, { signal, storedOnly = false, paperId }: { signal?: AbortSignal; storedOnly?: boolean; paperId?: string } = {}) {
  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) throw new ReadAloudError('AI_NOT_CONFIGURED');
  let response: Response;
  try {
    response = await authenticatedWorkerFetch(`${apiBase}/tts/paragraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(storedOnly ? { storedOnly } : {}), ...(paperId ? { paperId } : {}) }),
      signal,
    }, PARAGRAPH_TIMEOUT_MS);
  } catch (error) {
    throw new ReadAloudError((error as { name?: string } | null)?.name === 'WorkerApiAuthError' ? 'AI_AUTH_REQUIRED' : 'AI_UNAVAILABLE');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown; quota?: { scope?: unknown } } | null;
    throw new ReadAloudError(typeof body?.code === 'string' ? body.code : 'AI_UNAVAILABLE', typeof body?.quota?.scope === 'string' ? body.quota.scope : undefined);
  }
  return { blob: await response.blob(), key: response.headers.get('x-tts-audio') };
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
