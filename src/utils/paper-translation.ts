import type { Paper } from '../models/paper.ts';
import { canonicalArxivIdOf } from './paper-canonical-key.ts';
import { hasUsableAIAbstract } from './ai-explanation-access.ts';
import {
  isTranslationLanguage,
  type TranslationLanguage,
  translationSourceText,
} from './paper-translation-contract.ts';

export function translationSource(paper: Paper) {
  if (paper.sources.primary !== 'arxiv' || paper.abstractSource || !hasUsableAIAbstract(paper.abstract)) return null;
  const arxivId = canonicalArxivIdOf(paper)?.replace(/^([a-z-]+)\.[a-z]{2}\//, '$1/');
  const text = translationSourceText(paper.title, paper.abstract);
  return arxivId && /^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})$/.test(arxivId) && text
    ? { arxivId, ...text } : null;
}

export function defaultTranslationLanguage(languages: readonly string[]): TranslationLanguage | '' {
  for (const tag of languages) {
    const [language, ...subtags] = tag.toLowerCase().split('-');
    if (language === 'zh') {
      if (subtags.includes('hans')) return 'zh-Hans';
      return subtags.some(tag => ['hant', 'tw', 'hk', 'mo'].includes(tag)) ? 'zh-Hant' : 'zh-Hans';
    } else if (language === 'iw') {
      return 'he';
    } else if (isTranslationLanguage(language)) {
      return language;
    }
  }
  return '';
}

export function preferredTranslationLanguage(uid: string, languages: readonly string[], storage: Pick<Storage, 'getItem'> | undefined) {
  const saved = storage?.getItem(`papertok:paper-translation-language:${uid}`);
  return isTranslationLanguage(saved) ? saved : defaultTranslationLanguage(languages);
}

export function rememberTranslationLanguage(uid: string, language: TranslationLanguage, storage: Pick<Storage, 'setItem'>) {
  storage.setItem(`papertok:paper-translation-language:${uid}`, language);
}
