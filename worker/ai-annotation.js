import {
  AIExplanationError,
  classifyGeminiError,
  cleanText,
  getDailyQuotaReset,
  getProviderRetry,
  normalizeExplanationLanguage,
  releaseAIQuota,
  reserveAIQuota,
  shouldRefundAIQuota,
  verifyFirebaseAccount,
} from './ai-explanation.js';

/**
 * One passage, explained where the reader is standing.
 *
 * This is the smallest of the three AI routes and it is deliberately not built
 * like the other two. `/ai/explain` reads a whole paper and `/ai/rewrite`
 * streams one; this one answers a question about forty words the reader already
 * has in front of them, and it is asked mid-sentence, so what it optimises for
 * is arriving quickly. Hence: no PDF fetch, no provider chain, no streaming, a
 * single short call with a low thinking budget, and a hard cap on the answer.
 *
 * A long answer here would also be the wrong answer. The reader did not ask for
 * a second rewrite of the paper; they pointed at one sentence and asked what it
 * means. The prompt says so, and `MAX_NOTE_CHARS` enforces it even when the
 * model does not listen.
 */

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MAX_REQUEST_BYTES = 20_000;
/** Long enough for three or four sentences, short enough to read in a margin. */
export const MAX_NOTE_CHARS = 700;
/** A micro-interaction. Past this the reader has stopped waiting for it. */
const ANNOTATION_BUDGET_MS = 14_000;

const LEVEL_VOICE = {
  beginner: {
    es: 'Escribe para alguien curioso sin formación en el área. Define cualquier término técnico que uses.',
    en: 'Write for a curious reader with no training in the field. Define any technical term you use.',
  },
  university: {
    es: 'Escribe para un estudiante universitario del área general, pero no de esta especialidad.',
    en: 'Write for a university student in the broad field, but not in this specialty.',
  },
  researcher: {
    es: 'Escribe para alguien que investiga en un área cercana: puedes dar por sabido el vocabulario estándar.',
    en: 'Write for someone doing research in a neighbouring field: standard vocabulary can be assumed.',
  },
};

export function isAnnotationLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVEL_VOICE, level);
}

/**
 * The passage, plus just enough around it to make it mean something.
 *
 * A quote pulled out of a paragraph frequently cannot be explained on its own —
 * "esa cantidad" refers to something in the sentence before. The paragraph it
 * came from travels with it as context and is explicitly marked as context, so
 * the model explains the selection rather than summarising the paragraph.
 */
export function buildAnnotationPrompt({ paper, quote, context, level, language }) {
  const es = language !== 'en';
  const voice = LEVEL_VOICE[level][es ? 'es' : 'en'];
  const title = cleanText(paper?.title, 500);

  if (es) {
    return `Un lector está leyendo una versión en lenguaje sencillo del artículo «${title}» y ha señalado un fragmento que no entiende.

PÁRRAFO COMPLETO (solo como contexto, no lo resumas):
${context}

FRAGMENTO SEÑALADO:
${quote}

Explica QUÉ SIGNIFICA ESE FRAGMENTO. ${voice}

Reglas:
- Entre dos y cuatro frases. Nada más.
- Empieza por lo que el fragmento quiere decir, no por «este fragmento dice que».
- Si el fragmento depende de algo dicho antes en el párrafo, dilo explícitamente.
- Si el fragmento no se puede explicar sin datos que no están aquí, dilo en una frase en vez de inventarlos.
- Texto llano. Sin listas, sin títulos, sin markdown, sin comillas alrededor de la respuesta.`;
  }

  return `A reader is working through a plain-language version of the paper "${title}" and has pointed at a passage they do not follow.

FULL PARAGRAPH (context only — do not summarise it):
${context}

THE PASSAGE THEY POINTED AT:
${quote}

Explain WHAT THAT PASSAGE MEANS. ${voice}

Rules:
- Between two and four sentences. No more.
- Open with what the passage means, not with "this passage says that".
- If the passage depends on something said earlier in the paragraph, say so explicitly.
- If it cannot be explained without facts that are not here, say that in one sentence rather than inventing them.
- Plain text. No lists, no headings, no markdown, no quotation marks around the answer.`;
}

/**
 * Pulls the answer out of Gemini's envelope and holds it to the shape the
 * margin can show: one paragraph, no markdown scaffolding, bounded length.
 */
export function parseAnnotationPayload(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  const raw = Array.isArray(parts)
    ? parts.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
    : '';
  const note = String(raw)
    // Models reach for a bullet or a bold lead even when told not to; stripping
    // is kinder than refusing an answer that is otherwise correct.
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s*\n\s*\n\s*/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“«]|["”»]$/g, '')
    .trim();
  if (!note) throw new AIExplanationError('AI_EMPTY_RESPONSE', 502);
  return note.slice(0, MAX_NOTE_CHARS);
}

async function requestAnnotation({ env, model, prompt, language, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            // The cheapest thinking this model offers: the question is small and
            // the reader is waiting mid-sentence.
            thinkingConfig: { thinkingLevel: 'low' },
            maxOutputTokens: 600,
            temperature: 0.2,
          },
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = classifyGeminiError(response.status, payload);
      throw new AIExplanationError(
        code,
        code === 'AI_NOT_CONFIGURED' ? 503 : response.status === 429 ? 429 : 502,
        code,
        code === 'AI_QUOTA_EXHAUSTED'
          ? { ...getDailyQuotaReset(), scope: 'provider' }
          : code === 'AI_BUSY'
            ? getProviderRetry(payload, response.headers.get('retry-after'))
            : null,
      );
    }
    const note = parseAnnotationPayload(payload);
    console.info('AI annotation', JSON.stringify({
      model,
      language,
      outcome: 'success',
      chars: note.length,
      durationMs: Date.now() - startedAt,
    }));
    return { note, model };
  } catch (error) {
    const normalized = error instanceof AIExplanationError
      ? error
      // An abort here is the budget, not the caller: the reader's own abort
      // never reaches the Worker.
      : new AIExplanationError(error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', 502);
    console.warn('AI annotation', JSON.stringify({
      model,
      language,
      outcome: normalized.code,
      durationMs: Date.now() - startedAt,
    }));
    throw normalized;
  } finally {
    clearTimeout(timeout);
  }
}

export async function handlePassageAnnotation(request, env) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new AIExplanationError('AI_REQUEST_TOO_LARGE', 413);
  const account = await verifyFirebaseAccount(request, env);
  const payload = await request.json().catch(() => null);
  if (!payload || JSON.stringify(payload).length > MAX_REQUEST_BYTES) {
    throw new AIExplanationError('AI_INVALID_REQUEST', 400);
  }

  const level = cleanText(payload.level, 30);
  if (!isAnnotationLevel(level)) throw new AIExplanationError('AI_INVALID_LEVEL', 400);
  const language = normalizeExplanationLanguage(payload.language);
  const quote = cleanText(payload.quote, 600);
  // Eight characters is the floor the client anchors highlights at; below it a
  // quote does not identify a passage, so there is nothing to explain.
  if (quote.length < 8) throw new AIExplanationError('AI_INVALID_REQUEST', 400);
  const context = cleanText(payload.context, 4_000) || quote;
  const paper = { title: cleanText(payload?.paper?.title, 1_000) };
  if (!env.GEMINI_API_KEY) throw new AIExplanationError('AI_NOT_CONFIGURED', 503);

  const model = cleanText(env.AI_ANNOTATION_MODEL || DEFAULT_MODEL, 100) || DEFAULT_MODEL;
  // Reserved before the call and handed back by the same predicate the other
  // two routes use, so a provider outage never costs the reader a use.
  const quota = await reserveAIQuota(env, account.uid, { unlimited: account.unlimitedAI });
  try {
    const result = await requestAnnotation({
      env,
      model,
      prompt: buildAnnotationPrompt({ paper, quote, context, level, language }),
      language,
      timeoutMs: ANNOTATION_BUDGET_MS,
    });
    return { ...result, level, language, remainingUses: quota.remainingUses };
  } catch (error) {
    if (shouldRefundAIQuota(error)) await releaseAIQuota(env, quota);
    throw error;
  }
}
