import { getCategoryLabel } from '../data/categories.js';
import { isTechnicalClassification } from './scientificClassification.js';
import { resolvePaperTopic } from './topicNavigation.js';

function normalizedLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function conceptLabel(concept) {
  return typeof concept === 'string'
    ? concept.trim()
    : String(
      concept?.display_name || concept?.displayName || concept?.name || concept?.label || '',
    ).trim();
}

/**
 * What a chip prints, and in which language.
 *
 * A chip that resolves to one of the app's own topics prints that topic's
 * label, in the interface language: the chip used to resolve "Oncology" to the
 * Spanish topic for its link and title and still print "Oncology" (42 of 91
 * chips on the guest's OpenAlex cards, audit 2026-09-23). Our own
 * translation of a category code (`getCategoryLabel`) is also ours. Anything
 * else is the provider's text, printed as given and marked English, so a
 * screen reader in the Spanish UI does not read it as Spanish.
 */
function chipText(topic, providerLabel, translatedLabel) {
  if (topic.reliable) return { label: topic.label, lang: undefined, identity: `topic:${topic.id}` };
  if (translatedLabel) return { label: translatedLabel, lang: undefined, identity: normalizedLabel(translatedLabel) };
  return { label: providerLabel, lang: 'en', identity: normalizedLabel(providerLabel) };
}

export function buildPaperTopicTags(paper, limit = 4, language = 'es') {
  const primaryCategory = paper?.primaryCategory || paper?.categories?.[0] || '';
  const primaryLabel = getCategoryLabel(primaryCategory, language);
  const primaryTopic = primaryCategory
    ? resolvePaperTopic({ categoryId: primaryCategory, categoryIds: [primaryCategory], display_name: primaryLabel, query: primaryCategory, source: 'category' }, language)
    : null;
  // The category pill already says the primary category; no chip repeats it,
  // in either language.
  const seen = new Set([
    normalizedLabel(primaryCategory),
    normalizedLabel(primaryLabel),
    primaryTopic?.reliable ? `topic:${primaryTopic.id}` : '',
  ].filter(Boolean));
  const tags = [];

  for (const category of paper?.categories || []) {
    const label = getCategoryLabel(category, language);
    if (
      !normalizedLabel(label)
      || category === primaryCategory
      || isTechnicalClassification(category)
      || isTechnicalClassification(label)
    ) continue;
    const value = {
      categoryId: category,
      categoryIds: [category],
      display_name: label,
      query: category,
      source: 'category',
    };
    const topic = resolvePaperTopic(value, language);
    if (!topic) continue;
    const text = chipText(topic, label, label !== category ? label : '');
    if (seen.has(text.identity) || seen.has(normalizedLabel(text.label))) continue;
    seen.add(text.identity);
    seen.add(normalizedLabel(text.label));
    tags.push({
      key: `category:${category}`,
      label: text.label,
      ...(text.lang ? { lang: text.lang } : {}),
      value,
      source: 'category',
    });
    if (tags.length >= limit) return tags;
  }

  for (const concept of paper?.concepts || []) {
    const label = conceptLabel(concept);
    const normalized = normalizedLabel(label);
    if (!normalized || isTechnicalClassification(label)) continue;
    const topic = resolvePaperTopic(concept, language);
    if (!topic) continue;
    const text = chipText(topic, label, '');
    if (seen.has(text.identity) || seen.has(normalizedLabel(text.label))) continue;
    seen.add(text.identity);
    seen.add(normalizedLabel(text.label));
    tags.push({
      key: `concept:${concept?.id || normalized}`,
      label: text.label,
      ...(text.lang ? { lang: text.lang } : {}),
      value: concept,
      source: 'concept',
    });
    if (tags.length >= limit) break;
  }

  return tags;
}
