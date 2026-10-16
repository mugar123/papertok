import type { ShareOptions } from '../utils/publicNavigation.ts';
type LocalizedText = string | Record<string, string | undefined> | null;
interface MetadataOptions extends ShareOptions {
  title?: LocalizedText; description?: LocalizedText; imageAlt?: LocalizedText; url?: string; route?: string; image?: string;
  ogType?: string; type?: string; jsonLd?: unknown; structuredData?: unknown; noIndex?: boolean; robots?: string;
}
interface NodeRecord { node: Element; existed: boolean; content: string | null; href: string | null; textContent: string | null; }

import { useEffect, useMemo } from 'react';
import { useLanguage } from '../context/LanguageContext.jsx';
import {
  DEFAULT_SHARE_IMAGE_PATH,
  getAbsoluteShareUrl,
  getSiteRootUrl,
} from '../utils/publicNavigation.ts';

const ROOT_METADATA = {
  title: {
    en: 'PaperTok — Discover scientific research',
  },
  description: {
    en: 'PaperTok is an application for exploring and discovering scientific papers from multiple sources.',
  },
  imageAlt: {
    en: 'A scientific paper view in PaperTok',
  },
};

const EMPTY_OPTIONS: MetadataOptions = {};

function cleanText(value: unknown) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function resolveLocalized(value: LocalizedText | undefined, language: string, fallback: string) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return cleanText(value[language] || value.default) || fallback;
  }
  return cleanText(value) || fallback;
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function resolveAbsoluteHttpUrl(value: unknown, rootUrl: string) {
  const rawValue = cleanText(value);
  if (!rawValue) return '';
  if (isHttpUrl(rawValue)) {
    try {
      const url = new URL(rawValue);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  try {
    return new URL(rawValue.replace(/^\/+/, ''), rootUrl).href;
  } catch {
    return '';
  }
}

function resolvePageUrl(value: unknown, navigationOptions: ShareOptions, rootUrl: string) {
  const rawValue = cleanText(value);
  if (!rawValue) return rootUrl;
  if (rawValue.startsWith('#') || rawValue.startsWith('/public/')) {
    return getAbsoluteShareUrl(rawValue, navigationOptions) || rootUrl;
  }
  return resolveAbsoluteHttpUrl(rawValue, rootUrl) || rootUrl;
}

function buildStructuredData({
  title,
  description,
  pageUrl,
  imageUrl,
  rootUrl,
  customData,
}: { title: string; description: string; pageUrl: string; imageUrl: string; rootUrl: string; customData?: unknown; language?: string }) {
  const baseData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description,
    url: pageUrl,
    image: imageUrl,
    inLanguage: 'en-US',
    isPartOf: {
      '@type': 'WebSite',
      name: 'PaperTok',
      url: rootUrl,
    },
  };

  if (!customData) return baseData;
  if (Array.isArray(customData)) return customData;
  if (typeof customData === 'object') return { ...baseData, ...customData };
  return baseData;
}

function findMeta(attribute: string, value: string|null) {
  return Array.from(document.head.querySelectorAll(`meta[${attribute}]`))
    .find(node => node.getAttribute(attribute) === value) || null;
}

function rememberNode(records: NodeRecord[], node: Element, existed: boolean) {
  records.push({
    node,
    existed,
    content: node.getAttribute('content'),
    href: node.getAttribute('href'),
    textContent: node.textContent,
  });
}

function upsertMeta(records: NodeRecord[], attribute: string, key: string, content: string) {
  let node = findMeta(attribute, key);
  const existed = Boolean(node);
  if (!node) {
    node = document.createElement('meta');
    node.setAttribute(attribute, key);
    document.head.appendChild(node);
  }
  rememberNode(records, node, existed);
  node.setAttribute('content', content);
}

function upsertCanonical(records: NodeRecord[], href: string) {
  let node = document.head.querySelector('link[rel="canonical"]');
  const existed = Boolean(node);
  if (!node) {
    node = document.createElement('link');
    node.setAttribute('rel', 'canonical');
    document.head.appendChild(node);
  }
  rememberNode(records, node, existed);
  node.setAttribute('href', href);
}

function upsertJsonLd(records: NodeRecord[], value: unknown) {
  let node = document.head.querySelector<HTMLScriptElement>('#papertok-jsonld');
  const existed = Boolean(node);
  if (!node) {
    node = document.createElement('script');
    node.id = 'papertok-jsonld';
    node.type = 'application/ld+json';
    document.head.appendChild(node);
  }
  rememberNode(records, node, existed);
  node.type = 'application/ld+json';
  node.textContent = JSON.stringify(value).replace(/</g, '\\u003c');
}

function restoreNodes(records: NodeRecord[]) {
  for (const record of records.reverse()) {
    if (!record.existed) {
      record.node.remove();
      continue;
    }
    if (record.node.tagName === 'LINK') {
      if (record.href === null) record.node.removeAttribute('href');
      else record.node.setAttribute('href', record.href);
    } else if (record.node.tagName === 'SCRIPT') {
      record.node.textContent = record.textContent;
    } else if (record.content === null) {
      record.node.removeAttribute('content');
    } else {
      record.node.setAttribute('content', record.content);
    }
  }
}

export function usePublicPageMetadata(options = EMPTY_OPTIONS) {
  const { language } = useLanguage();
  const config = options || EMPTY_OPTIONS;

  const metadata = useMemo(() => {
    const navigationOptions = {
      origin: config.origin,
      base: config.base,
    };
    const rootUrl = getSiteRootUrl(navigationOptions);
    const title = resolveLocalized(config.title, language, ROOT_METADATA.title[language as keyof typeof ROOT_METADATA.title]);
    const description = resolveLocalized(config.description, language, ROOT_METADATA.description[language as keyof typeof ROOT_METADATA.description]);
    const imageAlt = resolveLocalized(config.imageAlt, language, ROOT_METADATA.imageAlt[language as keyof typeof ROOT_METADATA.imageAlt]);
    const pageUrl = resolvePageUrl(config.url || config.route, navigationOptions, rootUrl);
    const imageUrl = resolveAbsoluteHttpUrl(config.image || DEFAULT_SHARE_IMAGE_PATH, rootUrl);
    const ogType = cleanText(config.ogType || config.type) || 'website';
    const jsonLd = buildStructuredData({
      title,
      description,
      pageUrl,
      imageUrl,
      language,
      rootUrl,
      customData: config.jsonLd || config.structuredData,
    });

    return {
      title,
      description,
      imageAlt,
      pageUrl,
      imageUrl,
      ogType,
      robots: config.noIndex ? 'noindex, nofollow' : cleanText(config.robots) || 'index, follow',
      locale: 'en_US',
      jsonLd,
    };
  }, [config, language]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const records: NodeRecord[] = [];
    const previousTitle = document.title;
    const previousLanguage = document.documentElement.getAttribute('lang');
    document.title = metadata.title;
    document.documentElement.setAttribute('lang', language);
    // Remember what we just set: `AnimatePresence mode="wait"` in App.jsx
    // keeps the outgoing route mounted for EXIT_MS (~200ms) after the
    // pathname already changed, so this cleanup runs well after the new
    // route's RouteAnnouncer has already written the new title. Restoring
    // unconditionally would stomp that newer title with this stale one; only
    // restore if nothing else has claimed document.title since.
    const titleWeSet = metadata.title;

    upsertMeta(records, 'name', 'description', metadata.description);
    upsertMeta(records, 'name', 'robots', metadata.robots);
    upsertMeta(records, 'property', 'og:title', metadata.title);
    upsertMeta(records, 'property', 'og:description', metadata.description);
    upsertMeta(records, 'property', 'og:type', metadata.ogType);
    upsertMeta(records, 'property', 'og:url', metadata.pageUrl);
    upsertMeta(records, 'property', 'og:site_name', 'PaperTok');
    upsertMeta(records, 'property', 'og:locale', metadata.locale);
    upsertMeta(records, 'property', 'og:image', metadata.imageUrl);
    upsertMeta(records, 'property', 'og:image:alt', metadata.imageAlt);
    upsertMeta(records, 'property', 'og:image:width', '1200');
    upsertMeta(records, 'property', 'og:image:height', '630');
    upsertMeta(records, 'property', 'og:image:type', 'image/png');
    upsertMeta(records, 'name', 'twitter:card', 'summary_large_image');
    upsertMeta(records, 'name', 'twitter:title', metadata.title);
    upsertMeta(records, 'name', 'twitter:description', metadata.description);
    upsertMeta(records, 'name', 'twitter:url', metadata.pageUrl);
    upsertMeta(records, 'name', 'twitter:image', metadata.imageUrl);
    upsertMeta(records, 'name', 'twitter:image:alt', metadata.imageAlt);
    upsertCanonical(records, metadata.pageUrl);
    upsertJsonLd(records, metadata.jsonLd);

    return () => {
      if (document.title === titleWeSet) document.title = previousTitle;
      if (previousLanguage === null) document.documentElement.removeAttribute('lang');
      else document.documentElement.setAttribute('lang', previousLanguage);
      restoreNodes(records);
    };
  }, [language, metadata]);

  return metadata;
}
