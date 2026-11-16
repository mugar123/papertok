import type { WorkerEnv } from './env.ts';
import { AIExplanationError, getDailyQuotaReset, sha256, verifyFirebaseAccount } from './ai-explanation.ts';
import { readBoundedJson } from './bounded-body.ts';
import { releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.ts';

export const READ_ALOUD_PATH = '/tts/paragraph';

const CARTESIA_URL = 'https://api.cartesia.ai/tts/bytes';
const CARTESIA_VERSION = '2026-08-14';
const MODEL = 'sonic-3.6-2026-08-27';
const VOICE = 'f786b574-daa5-4673-aa0c-cbe3e8534c02';
const OUTPUT_FORMAT = { container: 'mp3', sample_rate: 44_100, bit_rate: 64_000 };
const MAX_REQUEST_BYTES = 12_000;
export const MAX_PARAGRAPH_CHARS = 3_000;
const SYNTHESIS_TIMEOUT_MS = 30_000;
const DEFAULT_USER_DAILY_CHARS = 150_000;
const DEFAULT_GLOBAL_DAILY_CHARS = 258_000;

function dailyLimit(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : fallback;
}

export function audioKey(text: string) {
  return sha256(`${MODEL}\n${VOICE}\n${OUTPUT_FORMAT.bit_rate}\n${text}`).then(hash => `tts/${hash}.mp3`);
}

async function cartesiaFailure(response: Response) {
  const body = await response.json().catch(() => null) as { error_code?: unknown } | null;
  const code = typeof body?.error_code === 'string' ? body.error_code : '';
  if (code === 'quota_exceeded' || code === 'plan_upgrade_required' || response.status === 402) {
    return new AIExplanationError('AI_QUOTA_EXHAUSTED', 429, 'AI_QUOTA_EXHAUSTED', { ...getDailyQuotaReset(), scope: 'provider' });
  }
  if (response.status === 429) return new AIExplanationError('AI_BUSY', 429);
  if (response.status === 401 || response.status === 403) return new AIExplanationError('AI_NOT_CONFIGURED', 503);
  return new AIExplanationError('AI_UNAVAILABLE', 502);
}

/**
 * One paragraph of a paper's text as MP3. The text is the same for
 * every reader, so the audio is stored by a hash of the text, voice and model
 * and synthesized at most once; only a miss spends the reader's daily
 * character allowance. `storedOnly` asks for stored audio and nothing else, so
 * a reader whose voice ran out of credits still gets every paragraph already made.
 */
export async function handleReadAloud(request: Request, env: WorkerEnv) {
  if (Number(request.headers.get('content-length') || 0) > MAX_REQUEST_BYTES) {
    throw new AIExplanationError('AI_REQUEST_TOO_LARGE', 413);
  }
  const account = await verifyFirebaseAccount(request, env);
  const payload = await readBoundedJson<{ text?: unknown; storedOnly?: unknown }>(request, MAX_REQUEST_BYTES, {
    tooLarge: () => new AIExplanationError('AI_REQUEST_TOO_LARGE', 413),
    invalid: () => new AIExplanationError('AI_INVALID_REQUEST', 400),
  });
  const text = typeof payload?.text === 'string' ? payload.text.replace(/\0/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new AIExplanationError('AI_INVALID_REQUEST', 400);
  if (text.length > MAX_PARAGRAPH_CHARS) throw new AIExplanationError('AI_REQUEST_TOO_LARGE', 413);
  const store = env.TTS_AUDIO;
  if (!store) throw new AIExplanationError('AI_NOT_CONFIGURED', 503);

  const key = await audioKey(text);
  const stored = await store.get(key);
  if (stored) return stored.arrayBuffer();
  if (payload?.storedOnly === true) throw new AIExplanationError('AI_AUDIO_NOT_STORED', 404);
  if (!env.CARTESIA_API_KEY) throw new AIExplanationError('AI_NOT_CONFIGURED', 503);

  const ledgerRequest = {
    periodKey: `tts:${new Date().toISOString().slice(0, 10)}`,
    subject: `tts:${account.uid}`,
    subjectLimit: dailyLimit(env.TTS_DAILY_USER_CHARS, DEFAULT_USER_DAILY_CHARS),
    globalLimit: dailyLimit(env.TTS_DAILY_GLOBAL_CHARS, DEFAULT_GLOBAL_DAILY_CHARS),
    amount: text.length,
  };
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, ledgerRequest);
  if (!reservation.accepted) {
    if (reservation.code) {
      throw new AIExplanationError(reservation.code === 'QUOTA_LEDGER_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE', 503);
    }
    throw new AIExplanationError('AI_QUOTA_EXHAUSTED', 429, 'AI_QUOTA_EXHAUSTED', {
      ...getDailyQuotaReset(),
      scope: reservation.scope || 'global',
    });
  }

  try {
    const response = await fetch(CARTESIA_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CARTESIA_API_KEY}`,
        'cartesia-version': CARTESIA_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model_id: MODEL,
        transcript: text,
        voice: { mode: 'id', id: VOICE },
        output_format: OUTPUT_FORMAT,
        language: 'en',
      }),
      signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
    });
    if (!response.ok) throw await cartesiaFailure(response);
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) throw new AIExplanationError('AI_EMPTY_RESPONSE', 502);
    await store.put(key, audio, { httpMetadata: { contentType: 'audio/mpeg' } }).catch((error: unknown) => {
      console.error('Read-aloud audio not stored', error);
    });
    return audio;
  } catch (error) {
    await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, ledgerRequest).catch(() => undefined);
    if (error instanceof AIExplanationError) throw error;
    throw new AIExplanationError((error as Error)?.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', 502);
  }
}
