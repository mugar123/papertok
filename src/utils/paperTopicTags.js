import { getCategoryLabel } from '../data/categories.js';

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
    : String(concept?.display_name || concept?.name || '').trim();
}

export function buildPaperTopicTags(paper, limit = 4) {
  const primaryCategory = paper?.primaryCategory || paper?.categories?.[0] || '';
  const seen = new Set([
    normalizedLabel(primaryCategory),
    normalizedLabel(getCategoryLabel(primaryCategory)),
  ].filter(Boolean));
  const tags = [];

  for (const category of paper?.categories || []) {
    const label = getCategoryLabel(category);
    const normalized = normalizedLabel(label);
    if (!normalized || category === primaryCategory || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push({
      key: `category:${category}`,
      label,
      value: category,
      source: 'category',
    });
    if (tags.length >= limit) return tags;
  }

  for (const concept of paper?.concepts || []) {
    const label = conceptLabel(concept);
    const normalized = normalizedLabel(label);
    if (!normalized || seen.has(normalized)) continue;
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
