export const TRANSLATION_LANGUAGES = {
  ar: 'Arabic',
  eu: 'Basque',
  bn: 'Bengali',
  ca: 'Catalan',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  nl: 'Dutch',
  fr: 'French',
  gl: 'Galician',
  de: 'German',
  he: 'Hebrew',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  fa: 'Persian',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  es: 'Spanish',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
} as const;

export type TranslationLanguage = keyof typeof TRANSLATION_LANGUAGES;

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && Object.hasOwn(TRANSLATION_LANGUAGES, value);
}

export const RTL_TRANSLATION_LANGUAGES: ReadonlySet<TranslationLanguage> = new Set(['ar', 'fa', 'he', 'ur']);

const EXTENDED_OUTPUT_LANGUAGES = new Set<TranslationLanguage>(['ar', 'bn', 'fa', 'he', 'hi', 'ja', 'ko', 'ur', 'zh-Hans', 'zh-Hant']);

export function translatedChunkLimits(language: TranslationLanguage) {
  return EXTENDED_OUTPUT_LANGUAGES.has(language)
    ? { tokens: 14_000, bytes: 80_000 }
    : { tokens: 6_000, bytes: 30_000 };
}

export const PAPER_TRANSLATION_MAX_CHUNKS = 16;
export const PAPER_TRANSLATION_CHUNK_BYTES = 6_000;
export const PAPER_TRANSLATION_REQUEST_BYTES = 1_024;
export const PAPER_TRANSLATION_HTML_BYTES = 2 * 1024 * 1024;
export const PAPER_TRANSLATION_CALL_MS = 25_000;
// Budget for every serial call, with time for authentication and source verification.
export const PAPER_TRANSLATION_DEADLINE_MS = PAPER_TRANSLATION_MAX_CHUNKS * PAPER_TRANSLATION_CALL_MS + 30_000;

const encoder = new TextEncoder();

export function translationJsonBytes(value: unknown) {
  return encoder.encode(JSON.stringify(value)).length;
}

type FullPaperTranslationRequest = {
  query: string;
  language: TranslationLanguage;
  fingerprint: string;
};

export function parseFullPaperTranslationRequest(value: unknown): FullPaperTranslationRequest | null {
  if (!value || typeof value !== 'object' || !('query' in value) || !('language' in value) || !('fingerprint' in value)) return null;
  const { query, language, fingerprint } = value;
  if (typeof query !== 'string' || !query || query.length > 512 || !isTranslationLanguage(language)) return null;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  return { query, language, fingerprint };
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every(item => typeof item === 'string' && item.trim().length > 0);
}

export function parseTranslatedChunk(value: unknown, expected: number, maxBytes: number): string[] | null {
  if (!isTextList(value) || value.length !== expected || translationJsonBytes(value) > maxBytes) return null;
  return value;
}

export async function fullPaperTranslationRevision(chunks: string[][]) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(chunks)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
