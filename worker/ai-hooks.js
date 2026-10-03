import {
  AIExplanationError,
  cleanText,
  sha256,
} from './ai-explanation.js';
import { readBoundedJson } from './bounded-body.js';
import { releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.js';
import { verifyFirebaseIdentity } from './firebase-auth.js';

/**
 * "Why it matters": one sentence per feed card, in front of the abstract.
 *
 * The feed shows a paper for a second or two before the reader decides whether
 * to stay, and an abstract is written for the paper's referees, not for that
 * second. This route turns title + abstract into a single plain sentence about
 * what the finding changes.
 *
 * It is built unlike the other AI routes on purpose:
 *
 *  - It runs for every card, guests included, so it cannot spend the reader's
 *    daily AI uses. It has its own allowance instead: a per-visitor daily cap
 *    and a global one, both in papers, on the request quota ledger.
 *  - A sentence is a property of the paper, not of the reader, so it is cached
 *    by the paper's own text and served to everyone who scrolls past it. Most
 *    requests after the first reader cost nothing.
 *  - Papers travel in batches (the next few cards of the feed) and go to the
 *    model in one call, not one call each.
 *  - A failure answers with fewer sentences, never with an error the card has
 *    to show: the card simply keeps its abstract.
 *
 * The sentence is generated text and the card labels it as such (invariant 3):
 * it is never presented as the authors' words.
 */

export const HOOK_PROMPT_VERSION = 'hooks-v2';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const MAX_HOOK_PAPERS = 6;
export const MAX_HOOK_CHARS = 240;
/** Below this an abstract is a stub, and a sentence built on it would be a guess. */
export const MIN_HOOK_ABSTRACT_CHARS = 200;
const MAX_REQUEST_BYTES = 48_000;
const HOOK_BUDGET_MS = 12_000;
const HOOK_CACHE_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_VISITOR_DAILY_LIMIT = 150;
const DEFAULT_GLOBAL_DAILY_LIMIT = 3_000;

function boundedLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

/** The papers the request names, cleaned, deduplicated, and capped. */
export function normalizeHookPapers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const papers = [];
  for (const item of value) {
    const id = cleanText(item?.id, 200);
    const title = cleanText(item?.title, 400);
    const abstract = cleanText(item?.abstract, 4_000);
    if (!id || seen.has(id) || !title || abstract.length < MIN_HOOK_ABSTRACT_CHARS) continue;
    seen.add(id);
    papers.push({ id, title, abstract });
    if (papers.length >= MAX_HOOK_PAPERS) break;
  }
  return papers;
}

export function buildHookPrompt(papers) {
  const list = papers.map((paper, index) => (
    `Paper ${index + 1}\nid: ${paper.id}\ntitle: ${paper.title}\nabstract: ${paper.abstract}`
  )).join('\n\n');
  return `You write the one line a curious reader sees on a scientific paper before deciding whether to read it.

For each paper below, write one sentence, at most 30 words, in English, saying why the result matters: what it lets someone do, understand, or stop worrying about.

Rules:
- Only claims the abstract supports. No invented numbers, applications, or comparisons.
- Plain words. Define nothing; avoid jargon, or use the everyday word for it.
- State it as a fact about the world, in the present tense: what is now known, possible, or ruled out.
- Never open with "This paper", "The authors", "Researchers", "This study", "You", "Understand" or "Learn".
- No hype ("groundbreaking", "revolutionary"), no questions, no emoji, no quotation marks.
- Keep math out of the sentence.

${list}

Return a JSON array with one object per paper: {"id": the paper's id exactly as given, "whyItMatters": the sentence}.`;
}

export function cleanHookSentence(value) {
  const sentence = String(value || '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“«']|["”»']$/g, '')
    .trim();
  if (!sentence) return '';
  if (sentence.length <= MAX_HOOK_CHARS) return sentence;
  // Past the cap the model ignored the brief; cut at a word and say so.
  return `${sentence.slice(0, MAX_HOOK_CHARS - 1).replace(/\s+\S*$/, '')}…`;
}

/** Maps the model's answer back onto the ids that were asked for, and only those. */
export function parseHookPayload(payload, papers) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  const raw = Array.isArray(parts)
    ? parts.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
    : '';
  let items;
  try {
    items = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(items)) return {};
  const wanted = new Set(papers.map(paper => paper.id));
  const hooks = {};
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : '';
    const text = cleanHookSentence(item?.whyItMatters);
    if (wanted.has(id) && text && !hooks[id]) hooks[id] = text;
  }
  return hooks;
}

async function hookCacheKey(paper, model) {
  const fingerprint = await sha256(`${paper.title}\n${paper.abstract}`);
  return new Request(`https://papertok.internal/ai-hooks/${HOOK_PROMPT_VERSION}/${encodeURIComponent(model)}/${fingerprint}`);
}

async function requestHooks({ env, model, papers, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HOOK_BUDGET_MS);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildHookPrompt(papers) }] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: 'low' },
            maxOutputTokens: 200 * papers.length,
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  id: { type: 'STRING' },
                  whyItMatters: { type: 'STRING' },
                },
                required: ['id', 'whyItMatters'],
              },
            },
          },
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new AIExplanationError('AI_UNAVAILABLE', 502);
    const hooks = parseHookPayload(payload, papers);
    console.info('AI hooks', JSON.stringify({
      model,
      asked: papers.length,
      answered: Object.keys(hooks).length,
      durationMs: Date.now() - startedAt,
    }));
    return hooks;
  } catch (error) {
    console.warn('AI hooks', JSON.stringify({
      model,
      outcome: error?.name === 'AbortError' ? 'AI_TIMEOUT' : (error?.code || 'AI_UNAVAILABLE'),
      durationMs: Date.now() - startedAt,
    }));
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

/** A signed-in reader is counted by account, a guest by connection. */
async function visitorSubject(request, env) {
  if (request.headers.get('authorization')) {
    try {
      const identity = await verifyFirebaseIdentity(request, env);
      if (identity?.uid) return `ai-hooks:user:${identity.uid}`;
    } catch {
      // An expired token is not a reason to refuse a guest's allowance.
    }
  }
  return `ai-hooks:ip:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
}

export async function handlePaperHooks(request, env, {
  fetchImpl = fetch,
  cache: injectedCache,
  now = () => new Date(),
} = {}) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new AIExplanationError('AI_REQUEST_TOO_LARGE', 413);
  const payload = await readBoundedJson(request, MAX_REQUEST_BYTES, {
    tooLarge: () => new AIExplanationError('AI_REQUEST_TOO_LARGE', 413),
    invalid: () => new AIExplanationError('AI_INVALID_REQUEST', 400),
  });
  const papers = normalizeHookPapers(payload?.papers);
  if (!papers.length || env.AI_HOOKS_DISABLED === 'true' || !env.GEMINI_API_KEY) return { hooks: {} };

  const cache = injectedCache || caches.default;
  const model = cleanText(env.AI_HOOK_MODEL || DEFAULT_MODEL, 100) || DEFAULT_MODEL;
  const hooks = {};
  const missing = [];
  const keys = new Map();
  await Promise.all(papers.map(async paper => {
    const key = await hookCacheKey(paper, model);
    keys.set(paper.id, key);
    const cached = await cache.match(key);
    const text = cached ? cleanHookSentence((await cached.json().catch(() => null))?.whyItMatters) : '';
    if (text) hooks[paper.id] = text;
    else missing.push(paper);
  }));
  if (!missing.length) return { hooks };

  // Counted in papers, reserved before the call and given back for every paper
  // the model did not answer: the allowance measures sentences delivered.
  const ledgerRequest = {
    periodKey: `ai-hooks:${now().toISOString().slice(0, 10)}`,
    subject: await visitorSubject(request, env),
    subjectLimit: boundedLimit(env.AI_HOOK_DAILY_VISITOR_LIMIT, DEFAULT_VISITOR_DAILY_LIMIT, 10_000),
    globalLimit: boundedLimit(env.AI_HOOK_DAILY_GLOBAL_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT, 1_000_000),
    amount: missing.length,
  };
  // An allowance that cannot be checked is not granted, and not an error
  // either: the cards that had a cached line keep it, the rest their abstract.
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, ledgerRequest).catch(() => null);
  if (!reservation?.accepted) return { hooks };

  const generated = await requestHooks({ env, model, papers: missing, fetchImpl });
  const unanswered = missing.filter(paper => !generated[paper.id]).length;
  if (unanswered > 0) {
    await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, { ...ledgerRequest, amount: unanswered }).catch(() => {});
  }
  await Promise.all(missing.map(async paper => {
    const text = generated[paper.id];
    if (!text) return;
    hooks[paper.id] = text;
    await cache.put(keys.get(paper.id), new Response(JSON.stringify({ whyItMatters: text, model }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${HOOK_CACHE_SECONDS}`,
      },
    }));
  }));
  return { hooks };
}
