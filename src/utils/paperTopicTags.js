import { getCategoryLabel } from '../data/categories.js';
import { isTechnicalClassification } from './scientificClassification.js';
import { resolvePaperTopic } from './topicNavigation.js';

function normalizedLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

export function buildPaperTopicTags(paper, limit = 4, language = 'es') {
  const primaryCategory = paper?.primaryCategory || paper?.categories?.[0] || '';
  const seen = new Set([
    normalizedLabel(primaryCategory),
    normalizedLabel(getCategoryLabel(primaryCategory, language)),
  ].filter(Boolean));
  const tags = [];

  for (const category of paper?.categories || []) {
    const label = getCategoryLabel(category, language);
    const normalized = normalizedLabel(label);
    if (
      !normalized
      || category === primaryCategory
      || seen.has(normalized)
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
    if (!resolvePaperTopic(value, language)) continue;
    seen.add(normalized);
    tags.push({
      key: `category:${category}`,
      label,
      value,
      source: 'category',
    });
    if (tags.length >= limit) return tags;
  }

  for (const concept of paper?.concepts || []) {
    const label = conceptLabel(concept);
    const normalized = normalizedLabel(label);
    if (!normalized || seen.has(normalized) || isTechnicalClassification(label)) continue;
    if (!resolvePaperTopic(concept, language)) continue;
    seen.add(normalized);
    tags.push({
      key: `concept:${concept?.id || normalized}`,
      label,
      value: concept,
      source: 'concept',
    });
    if (tags.length >= limit) break;
  }

  return tags;
}
