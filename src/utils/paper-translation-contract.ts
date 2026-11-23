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
export const SOURCE_LANGUAGES = { en: 'English', ...TRANSLATION_LANGUAGES } as const;
export type SourceLanguage = keyof typeof SOURCE_LANGUAGES;

export type PaperTranslationText = { title: string; abstract: string };
export type PaperTranslation = PaperTranslationText & { language: TranslationLanguage; sourceLanguage?: SourceLanguage };
export type PaperTranslationRequest = PaperTranslationText & {
  arxivId: string;
  language: TranslationLanguage;
};

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && Object.hasOwn(TRANSLATION_LANGUAGES, value);
}

export function translationSourceText(title: unknown, abstract: unknown): PaperTranslationText | null {
  if (typeof title !== 'string' || typeof abstract !== 'string') return null;
  const text = { title: title.trim(), abstract: abstract.trim() };
  if (!text.title || text.title.length > 500 || text.abstract.length < 40 || text.abstract.length > 3_000) return null;
  // Budget for serialized text, including JSON escapes and UTF-8 multibyte characters.
  return new TextEncoder().encode(JSON.stringify(text)).length <= 9_500 ? text : null;
}

export function parseTranslationText(value: unknown): (PaperTranslationText & { sourceLanguage?: SourceLanguage }) | null {
  if (!value || typeof value !== 'object' || !('title' in value) || !('abstract' in value)) return null;
  if (typeof value.title !== 'string' || typeof value.abstract !== 'string') return null;
  const title = value.title.trim();
  const abstract = value.abstract.trim();
  if (!title || title.length > 1_500 || !abstract || abstract.length > 9_000) return null;
  const reported = 'sourceLanguage' in value && typeof value.sourceLanguage === 'string'
    ? value.sourceLanguage.toLowerCase()
    : undefined;
  const sourceLanguage = Object.keys(SOURCE_LANGUAGES).find(
    (code): code is SourceLanguage => code.toLowerCase() === reported,
  );
  return sourceLanguage ? { title, abstract, sourceLanguage } : { title, abstract };
}
