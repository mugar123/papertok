import { CATEGORIES } from '../data/categories.js';

function normalizeLabel(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findLocalTopic(value) {
  if (!value) return null;
  if (CATEGORIES[value]) {
    return { id: value, label: CATEGORIES[value].label, type: 'topic', reliable: true };
  }

  const normalized = normalizeLabel(value);
  for (const [areaId, area] of Object.entries(CATEGORIES)) {
    if ([area.label, area.labelEn].some(label => normalizeLabel(label) === normalized)) {
      return { id: areaId, label: area.label, type: 'topic', reliable: true };
    }
    for (const [categoryId, category] of Object.entries(area.subcategories || {})) {
      if (categoryId === value || [category.label, category.labelEn].some(label => normalizeLabel(label) === normalized)) {
        return { id: categoryId, label: category.label, type: 'topic', reliable: true };
      }
    }
  }
  return null;
}

function isExplicitCategoryId(value) {
  if (!value) return false;
  if (CATEGORIES[value]) return true;
  if (Object.values(CATEGORIES).some(area => Boolean(area.subcategories?.[value]))) return true;
  return /^[a-z][a-z-]*(?:\.[A-Za-z][A-Za-z-]*)+$/.test(value) || /^(?:astro|cond|hep|nucl|nlin)-[a-z-]+$/i.test(value);
}

export function resolvePaperTopic(value) {
  const concept = typeof value === 'object' && value !== null ? value : null;
  const label = concept?.display_name || concept?.displayName || concept?.name || String(value || '');
  const local = findLocalTopic(concept?.categoryId || label) || findLocalTopic(value);
  if (local) return local;

  const rawId = concept?.id || concept?.openAlexId || '';
  const externalId = String(rawId).split('/').pop();
  if (/^C\d+$/i.test(externalId) && label) {
    return { id: externalId, label, type: 'concept', reliable: false };
  }
  return null;
}

export function topicExplorerPath(topic) {
  return topic ? `/explorer/${topic.type}/${encodeURIComponent(topic.id)}` : null;
}

export function paperMatchesLocalTopic(paper, topic) {
  const categoryIds = topic?.categoryIds || [];
  const explicitCategories = (paper?.categories || []).filter(isExplicitCategoryId);
  if (explicitCategories.length > 0 && categoryIds.includes(explicitCategories[0])) return true;
  if (explicitCategories.length === 0 && categoryIds.includes(paper?.primaryCategory)) return true;

  const paperCategories = [paper?.primaryCategory, ...(paper?.categories || [])].filter(Boolean);

  const topicLabels = [topic?.display_name, topic?.labelEn]
    .map(normalizeLabel)
    .filter(label => label.length >= 4);
  if (topicLabels.length === 0) return false;

  const conceptLabels = (paper?.concepts || []).map(concept => concept?.display_name || concept?.name || '');
  const searchableText = normalizeLabel([
    paper?.title,
    paper?.abstract,
    paper?.summary,
    ...paperCategories,
    ...conceptLabels,
  ].filter(Boolean).join(' '));

  return topicLabels.some(label => searchableText.includes(label));
}
