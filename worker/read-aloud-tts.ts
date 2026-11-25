import type { WorkerEnv } from './env.ts';
import { AIExplanationError, getDailyQuotaReset, sha256, verifyFirebaseAccount } from './ai-explanation.ts';
import { readBoundedJson } from './bounded-body.ts';
import { peekRequestQuota, releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.ts';

export const READ_ALOUD_PATH = '/tts/paragraph';
export const VOICE_PAPERS_PATH = '/tts/papers';

const MAX_REQUEST_BYTES = 12_000;
/** A paper's audio keys, about 70 bytes each, for the longest papers' few hundred paragraphs. */
const MAX_PAPERS_REQUEST_BYTES = 48_000;
const MAX_AUDIO_KEYS = 600;
export const MAX_PARAGRAPH_CHARS = 3_000;
/** One provider's call at most, and both together, inside the browser's 40 seconds. */
const SYNTHESIS_TIMEOUT_MS = 20_000;
const REQUEST_DEADLINE_MS = 34_000;
const DEFAULT_USER_DAILY_CHARS = 200_000;
/** New papers an account may have read in PaperTok's voice a day; a paper already counted, or stored, is free. */
const DEFAULT_USER_DAILY_PAPERS = 2;
const MAX_PAPER_ID_CHARS = 200;
/** Papers a feed asks about at once: a page of cards. */
const MAX_PAPERS_ASKED = 60;
/** How often a request waiting for another's audio of the same paragraph looks for it. */
const MAKING_POLL_MS = 1_000;
/**
 * When a paragraph's turn is cleared if the request holding it never gave it
 * back. The ledger clears a whole object at the earliest time it was given, so
 * a turn taken within a minute of an earlier failed attempt can be cleared
 * while it is held, and a second request may then pay for the same paragraph.
 */
const MAKING_HOLD_MS = 60_000;

type Synthesis = { audio: ArrayBuffer; alignment: Record<string, unknown> | null };

type Provider = {
  name: 'elevenlabs' | 'cartesia';
  /** Everything that changes how a text sounds; the stored audio is named by it. */
  voice: string;
  apiKey: (env: WorkerEnv) => string | undefined;
  dailyLimit: (env: WorkerEnv) => number;
  synthesize: (text: string, apiKey: string, signal: AbortSignal) => Promise<Synthesis>;
};

function dailyLimit(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : fallback;
}

function failure(response: Response, quotaExhausted: boolean) {
  if (quotaExhausted || response.status === 402) {
    return new AIExplanationError('AI_QUOTA_EXHAUSTED', 429, 'AI_QUOTA_EXHAUSTED', { ...getDailyQuotaReset(), scope: 'provider' });
  }
  if (response.status === 429) return new AIExplanationError('AI_BUSY', 429);
  if (response.status === 401 || response.status === 403) return new AIExplanationError('AI_NOT_CONFIGURED', 503);
  return new AIExplanationError('AI_UNAVAILABLE', 502);
}

function alignmentOf(value: unknown) {
  const alignment = value as Record<string, unknown> | null | undefined;
  const lists = [alignment?.characters, alignment?.character_start_times_seconds, alignment?.character_end_times_seconds];
  const [characters] = lists;
  return alignment && Array.isArray(characters) && characters.length > 0
    && lists.every(list => Array.isArray(list) && list.length === characters.length)
    ? alignment
    : null;
}

const ELEVENLABS_MODEL = 'eleven_flash_v2_5';
const ELEVENLABS_VOICE = 'EXAVITQu4vr4xnSDxMaL';
const ELEVENLABS_FORMAT = 'mp3_44100_64';

const elevenLabs: Provider = {
  name: 'elevenlabs',
  voice: `${ELEVENLABS_MODEL}\n${ELEVENLABS_VOICE}\n${ELEVENLABS_FORMAT}`,
  apiKey: env => env.ELEVENLABS_API_KEY,
  dailyLimit: env => dailyLimit(env.TTS_DAILY_ELEVENLABS_CHARS, 88_000),
  async synthesize(text, apiKey, signal) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/with-timestamps?output_format=${ELEVENLABS_FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, language_code: 'en' }),
      signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: { status?: unknown; code?: unknown } } | null;
      throw failure(response, body?.detail?.status === 'quota_exceeded' || body?.detail?.code === 'quota_exceeded');
    }
    const body = await response.json<{ audio_base64?: unknown; alignment?: unknown }>()
      .catch((error: unknown) => {
        throw (error as Error)?.name === 'TimeoutError' ? error : new AIExplanationError('AI_UNAVAILABLE', 502);
      });
    const audio = typeof body.audio_base64 === 'string' ? Uint8Array.from(atob(body.audio_base64), char => char.charCodeAt(0)).buffer : null;
    if (!audio || audio.byteLength === 0) throw new AIExplanationError('AI_EMPTY_RESPONSE', 502);
    return { audio, alignment: alignmentOf(body.alignment) };
  },
};

const CARTESIA_MODEL = 'sonic-3.6-2026-08-27';
const CARTESIA_VOICE = 'f786b574-daa5-4673-aa0c-cbe3e8534c02';
const CARTESIA_FORMAT = { container: 'mp3', sample_rate: 44_100, bit_rate: 64_000 };

const cartesia: Provider = {
  name: 'cartesia',
  voice: `${CARTESIA_MODEL}\n${CARTESIA_VOICE}\n${CARTESIA_FORMAT.bit_rate}`,
  apiKey: env => env.CARTESIA_API_KEY,
  dailyLimit: env => dailyLimit(env.TTS_DAILY_CARTESIA_CHARS, 258_000),
  async synthesize(text, apiKey, signal) {
    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'cartesia-version': '2026-08-14', 'content-type': 'application/json' },
      body: JSON.stringify({
        model_id: CARTESIA_MODEL,
        transcript: text,
        voice: { mode: 'id', id: CARTESIA_VOICE },
        output_format: CARTESIA_FORMAT,
        language: 'en',
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error_code?: unknown } | null;
      throw failure(response, body?.error_code === 'quota_exceeded' || body?.error_code === 'plan_upgrade_required');
    }
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) throw new AIExplanationError('AI_EMPTY_RESPONSE', 502);
    return { audio, alignment: null };
  },
};

/** In the order they are tried. */
const PROVIDERS = [cartesia, elevenLabs];
const VOICES = { elevenlabs: elevenLabs.voice, cartesia: cartesia.voice };

/** Where a provider's audio of this text is stored, without the extension. */
export function audioKey(provider: Provider['name'], text: string) {
  return sha256(`${VOICES[provider]}\n${text}`).then(hash => `tts/${hash}`);
}

/**
 * Where a paper whose every paragraph has stored audio is marked, by a hash of its id. The voices
 * are part of the name, so a change of voice, which makes new audio, takes the marks with it.
 */
const voicedKey = async (paperId: string) => `papers/${await sha256(Object.values(VOICES).join('\n'))}/${await sha256(paperId)}`;
const AUDIO_KEY = /^tts\/[0-9a-f]{64}$/;

const dayOf = (now = new Date()) => now.toISOString().slice(0, 10);

/** The account's count of new papers today, in the request ledger. */
function papersToday(env: WorkerEnv, uid: string, day: string) {
  return {
    periodKey: `tts:papers:${day}`,
    subject: `tts:papers:${uid}`,
    subjectLimit: dailyLimit(env.TTS_DAILY_USER_PAPERS, DEFAULT_USER_DAILY_PAPERS),
    globalLimit: 1_000_000,
  };
}

const ledgerFailure = (code: string) => new AIExplanationError(code === 'QUOTA_LEDGER_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE', 503);

/** Ledger objects of one account, paper and day, each holding a single use: counted, and made. */
async function paperMarkers(uid: string, paperId: string, day: string) {
  const hash = await sha256(`${day}\n${uid}\n${paperId}`);
  const marker = (name: string) => ({ periodKey: `tts:${name}:${hash}`, subject: `tts:${name}`, subjectLimit: 1, globalLimit: 1 });
  return { counted: marker('paper'), made: marker('paper-made') };
}

/**
 * Takes one of the account's papers for the day before a provider is paid, the first time the
 * paper needs new audio; a paper already taken today passes. Returns how to give it back, which
 * gives it back only while none of the paper's audio has been made that day, so a paragraph that
 * fails costs nothing and one made by another request at the same time keeps the paper counted.
 */
async function takePaper(env: WorkerEnv, uid: string, paperId: string, day: string) {
  const ledger = env.REQUEST_QUOTA_LEDGER ?? null;
  const markers = await paperMarkers(uid, paperId, day);
  const papers = papersToday(env, uid, day);
  const first = await reserveRequestQuota(ledger, markers.counted);
  if (first.code) throw ledgerFailure(first.code);
  const made = async () => { await reserveRequestQuota(ledger, markers.made); };
  if (!first.accepted) return { made, giveBack: async () => undefined };
  const counted = await reserveRequestQuota(ledger, papers);
  if (!counted.accepted) {
    await releaseRequestQuota(ledger, markers.counted).catch(() => undefined);
    if (counted.code) throw ledgerFailure(counted.code);
    throw new AIExplanationError('AI_QUOTA_EXHAUSTED', 429, 'AI_QUOTA_EXHAUSTED', { ...getDailyQuotaReset(), scope: 'user' });
  }
  return {
    made,
    giveBack: async () => {
      const reading = await peekRequestQuota(ledger, markers.made);
      if (reading.code || reading.remaining === 0) return;
      await releaseRequestQuota(ledger, papers);
      await releaseRequestQuota(ledger, markers.counted);
    },
  };
}

/**
 * One paragraph of a paper's text as MP3. The text is the same for every
 * reader, so the audio is stored by a hash of the text and the voice that read
 * it, and synthesized at most once: a request that finds another making the
 * same paragraph waits for its audio instead of paying for a second copy, and
 * the request making it finishes even if its reader has left (`keepAlive`).
 * ElevenLabs' audio is stored with the time it speaks each character. Cartesia
 * reads first, and ElevenLabs reads when Cartesia cannot: its day's characters
 * spent, out of credits, busy, down or not configured. Each provider has its
 * own day of characters and its own allowance per reader; a reader past their
 * Cartesia allowance gets no ElevenLabs. `storedOnly` asks for stored audio
 * and nothing else, so a reader whose allowance or the providers' characters
 * ran out still gets every paragraph already made. New audio needs `paperId`:
 * the first new paragraph of a paper that day takes one of the account's
 * papers (`TTS_DAILY_USER_PAPERS`), unless the account's AI is unlimited.
 * The audio's name comes back in `key`, which the viewer hands to
 * `/tts/papers` to mark the paper as voiced. `timings` asks for the
 * stored timings of the audio the paragraph is served with instead, as JSON,
 * and never synthesizes.
 */
export async function handleReadAloud(request: Request, env: WorkerEnv, keepAlive?: (work: Promise<unknown>) => void): Promise<{ body: ArrayBuffer; type: string; key?: string }> {
  if (Number(request.headers.get('content-length') || 0) > MAX_REQUEST_BYTES) {
    throw new AIExplanationError('AI_REQUEST_TOO_LARGE', 413);
  }
  const account = await verifyFirebaseAccount(request, env);
  const payload = await readBoundedJson<{ text?: unknown; storedOnly?: unknown; timings?: unknown; paperId?: unknown }>(request, MAX_REQUEST_BYTES, {
    tooLarge: () => new AIExplanationError('AI_REQUEST_TOO_LARGE', 413),
    invalid: () => new AIExplanationError('AI_INVALID_REQUEST', 400),
  });
  const paperId = typeof payload?.paperId === 'string' ? payload.paperId.trim().slice(0, MAX_PAPER_ID_CHARS) : '';
  const store = env.TTS_AUDIO;
  if (!store) throw new AIExplanationError('AI_NOT_CONFIGURED', 503);
  const text = typeof payload?.text === 'string' ? payload.text.replace(/\0/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new AIExplanationError('AI_INVALID_REQUEST', 400);
  if (text.length > MAX_PARAGRAPH_CHARS) throw new AIExplanationError('AI_REQUEST_TOO_LARGE', 413);

  const keys = await Promise.all(PROVIDERS.map(provider => audioKey(provider.name, text)));
  // The audio served is the first stored in the providers' order, and timings
  // belong to that clip alone: another voice speaks the same words at other times.
  if (payload?.timings === true) {
    const served = (await Promise.all(keys.map(key => store.head(`${key}.mp3`)))).findIndex(Boolean);
    const timings = served < 0 ? null : await store.get(`${keys[served]}.json`);
    if (!timings) throw new AIExplanationError('AI_TIMINGS_NOT_STORED', 404);
    return { body: await timings.arrayBuffer(), type: 'application/json' };
  }
  const storedAudio = async () => {
    const found = await Promise.all(keys.map(key => store.get(`${key}.mp3`)));
    const index = found.findIndex(Boolean);
    return index < 0 ? null : { body: await found[index]!.arrayBuffer(), type: 'audio/mpeg', key: keys[index] };
  };
  const stored = await storedAudio();
  if (stored) return stored;
  if (payload?.storedOnly === true) throw new AIExplanationError('AI_AUDIO_NOT_STORED', 404);
  if (!paperId) throw new AIExplanationError('AI_INVALID_REQUEST', 400);

  const deadline = Date.now() + REQUEST_DEADLINE_MS;
  // One request at a time makes a paragraph. The ledger object named after the
  // paragraph holds a single use, taken here and given back when this request ends.
  const making = { periodKey: `tts:making:${keys[0].slice('tts/'.length)}`, subject: 'tts:making', subjectLimit: 1, globalLimit: 1 };
  for (;;) {
    const turn = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, { ...making, expiresAt: Date.now() + MAKING_HOLD_MS });
    if (turn.accepted) break;
    if (turn.code) throw new AIExplanationError(turn.code === 'QUOTA_LEDGER_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE', 503);
    // A request that waited takes the turn only with time left for a provider's call; the viewer asks again.
    if (deadline - Date.now() < SYNTHESIS_TIMEOUT_MS + MAKING_POLL_MS) throw new AIExplanationError('AI_BUSY', 429);
    await new Promise(resolve => { setTimeout(resolve, MAKING_POLL_MS); });
    const made = await storedAudio();
    if (made) return made;
  }
  const work = (async () => {
    try {
      // Stored between this request's look at the bucket and its turn.
      const made = await storedAudio();
      if (made) return made;
      const paper = account.unlimitedAI ? null : await takePaper(env, account.uid, paperId, dayOf());
      try {
        const audio = await synthesize(env, store, account.uid, text, keys, deadline);
        await paper?.made().catch(() => undefined);
        return audio;
      } catch (error) {
        await paper?.giveBack().catch(() => undefined);
        throw error;
      }
    } finally {
      await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, making).catch(() => undefined);
    }
  })();
  keepAlive?.(work.catch(() => undefined));
  return work;
}

/** Asks each provider in order, within its day and the reader's allowance, and stores the first audio. */
async function synthesize(env: WorkerEnv, store: NonNullable<WorkerEnv['TTS_AUDIO']>, uid: string, text: string, keys: string[], deadline: number) {
  const day = dayOf();
  let refusal = new AIExplanationError('AI_NOT_CONFIGURED', 503);
  for (const [index, provider] of PROVIDERS.entries()) {
    const apiKey = provider.apiKey(env);
    const left = deadline - Date.now();
    if (!apiKey || left <= 0) continue;
    const ledgerRequest = {
      periodKey: `tts:${provider.name}:${day}`,
      subject: `tts:${uid}`,
      subjectLimit: dailyLimit(env.TTS_DAILY_USER_CHARS, DEFAULT_USER_DAILY_CHARS),
      globalLimit: provider.dailyLimit(env),
      amount: text.length,
    };
    const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, ledgerRequest);
    if (!reservation.accepted) {
      if (reservation.code) {
        throw new AIExplanationError(reservation.code === 'QUOTA_LEDGER_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE', 503);
      }
      const exhausted = new AIExplanationError('AI_QUOTA_EXHAUSTED', 429, 'AI_QUOTA_EXHAUSTED', {
        ...getDailyQuotaReset(),
        scope: reservation.scope || 'global',
      });
      if (reservation.scope === 'user' && index === 0) throw exhausted;
      // A provider that failed for now (busy, down, slow) says more than a later one's spent day.
      if (refusal.code === 'AI_NOT_CONFIGURED' || refusal.code === 'AI_QUOTA_EXHAUSTED') refusal = exhausted;
      continue;
    }

    try {
      const { audio, alignment } = await provider.synthesize(text, apiKey, AbortSignal.timeout(Math.min(SYNTHESIS_TIMEOUT_MS, left)));
      await Promise.all([
        store.put(`${keys[index]}.mp3`, audio, { httpMetadata: { contentType: 'audio/mpeg' } }),
        alignment ? store.put(`${keys[index]}.json`, JSON.stringify(alignment), { httpMetadata: { contentType: 'application/json' } }) : null,
      ]).catch((error: unknown) => {
        console.error('Read-aloud audio not stored', error);
      });
      return { body: audio, type: 'audio/mpeg', key: keys[index] };
    } catch (error) {
      await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, ledgerRequest).catch(() => undefined);
      refusal = error instanceof AIExplanationError
        ? error
        : new AIExplanationError((error as Error)?.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', 502);
      console.warn('Read-aloud provider failed', { provider: provider.name, code: refusal.code });
    }
  }
  throw refusal;
}

/**
 * The voice's day for an account and its feed's sign. `{ usage: true }` says how many new papers the
 * account has left today (`unlimited` when its AI is); with `paperId`, also whether that paper can
 * still be heard in PaperTok's voice without one (`paperOpen`): it was counted today, or all its
 * audio is stored. `{ paperId, voiced: true, audio }`, with the
 * name of every paragraph's audio the viewer was served, marks the paper as voiced once each of them
 * is in the bucket: the mark stands for audio made by Cartesia or ElevenLabs, never the browser's.
 * `{ papers }` names which of a page's papers are marked.
 */
export async function handleVoicePapers(request: Request, env: WorkerEnv) {
  if (Number(request.headers.get('content-length') || 0) > MAX_PAPERS_REQUEST_BYTES) {
    throw new AIExplanationError('AI_REQUEST_TOO_LARGE', 413);
  }
  const account = await verifyFirebaseAccount(request, env);
  const payload = await readBoundedJson<{ usage?: unknown; paperId?: unknown; voiced?: unknown; audio?: unknown; papers?: unknown }>(request, MAX_PAPERS_REQUEST_BYTES, {
    tooLarge: () => new AIExplanationError('AI_REQUEST_TOO_LARGE', 413),
    invalid: () => new AIExplanationError('AI_INVALID_REQUEST', 400),
  });
  if (payload?.usage === true) {
    if (account.unlimitedAI) return { unlimited: true };
    const day = dayOf();
    const ledger = env.REQUEST_QUOTA_LEDGER ?? null;
    const papers = papersToday(env, account.uid, day);
    const reading = await peekRequestQuota(ledger, papers);
    if (reading.code) throw ledgerFailure(reading.code);
    if (reading.remaining === undefined) throw new AIExplanationError('AI_UNAVAILABLE', 503);
    const usage = { papersLeft: reading.remaining, dailyPapers: papers.subjectLimit };
    const paperId = typeof payload.paperId === 'string' ? payload.paperId.trim() : '';
    if (!paperId || paperId.length > MAX_PAPER_ID_CHARS) return usage;
    const counted = await peekRequestQuota(ledger, (await paperMarkers(account.uid, paperId, day)).counted);
    if (counted.code) throw ledgerFailure(counted.code);
    const voiced = Boolean(await env.TTS_AUDIO?.head(await voicedKey(paperId)));
    return { ...usage, paperOpen: counted.remaining === 0 || voiced };
  }
  const store = env.TTS_AUDIO;
  if (!store) throw new AIExplanationError('AI_NOT_CONFIGURED', 503);
  if (Array.isArray(payload?.papers)) {
    const ids = [...new Set(payload.papers.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_PAPER_ID_CHARS))].slice(0, MAX_PAPERS_ASKED);
    const found = await Promise.all(ids.map(async id => Boolean(await store.head(await voicedKey(id)))));
    return { voiced: ids.filter((_, index) => found[index]) };
  }
  const paperId = typeof payload?.paperId === 'string' ? payload.paperId.trim() : '';
  const audio = Array.isArray(payload?.audio) ? [...new Set(payload.audio)] : [];
  if (payload?.voiced !== true || !paperId || paperId.length > MAX_PAPER_ID_CHARS || audio.length === 0 || audio.length > MAX_AUDIO_KEYS
    || !audio.every((key): key is string => typeof key === 'string' && AUDIO_KEY.test(key))) {
    throw new AIExplanationError('AI_INVALID_REQUEST', 400);
  }
  const mark = await voicedKey(paperId);
  if (await store.head(mark)) return { voiced: true };
  const stored = await Promise.all(audio.map(key => store.head(`${key}.mp3`)));
  if (!stored.every(Boolean)) return { voiced: false };
  await store.put(mark, '');
  return { voiced: true };
}
