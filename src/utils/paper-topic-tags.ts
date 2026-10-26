import type { Paper } from '../models/paper.ts';
import type { TopicInput, TopicTarget } from './topic-navigation.ts';

import { getArxivArchiveArea, getCategoryLabel } from '../data/category-taxonomy.ts';
import { areaLabelForPaper } from './area-accent.ts';
import { isTechnicalClassification } from './scientific-classification.ts';
import { resolvePaperTopic } from './topic-navigation.ts';

function normalizedLabel(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function conceptLabel(concept: string | TopicInput) {
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
function chipText(topic: TopicTarget, providerLabel: string, translatedLabel: string) {
  if (topic.reliable) return { label: topic.label, lang: undefined, identity: `topic:${topic.id}` };
  if (translatedLabel) return { label: translatedLabel, lang: undefined, identity: normalizedLabel(translatedLabel) };
  return { label: providerLabel, lang: 'en', identity: normalizedLabel(providerLabel) };
}

/** The masthead names a native category or an OpenAlex topic; source details are separate. */
export function getPaperClassification(paper: Partial<Paper>) {
  const category = [paper.primaryCategory, ...(paper.categories || [])]
    .find(id => id && !isTechnicalClassification(id) && getCategoryLabel(id) !== id);
  if (category) {
    const label = getCategoryLabel(category);
    return {
      label,
      sourceLabel: '',
      topic: resolvePaperTopic({ categoryId: category, categoryIds: [category], display_name: label, query: category, source: 'category' }),
    };
  }
  if (paper.primaryTopic?.display_name) {
    const topic = resolvePaperTopic(paper.primaryTopic);
    if (topic) return { label: paper.primaryTopic.display_name, sourceLabel: 'OpenAlex topic', topic };
  }
  return { label: areaLabelForPaper(paper) || paper.journal || 'Research Paper', sourceLabel: '', topic: null };
}

export function buildPaperTopicTags(paper: Partial<Paper>, limit = 4) {
  const classification = getPaperClassification(paper);
  const primaryTopic = classification.topic;
  const primaryCategory = primaryTopic?.categoryIds?.[0] || (primaryTopic?.reliable ? primaryTopic.id : '');
  const primaryLabel = classification.label;
  // The category pill already says the primary category; no chip repeats it,
  // in either language.
  const seen = new Set([
    normalizedLabel(primaryCategory),
    normalizedLabel(primaryLabel),
    primaryTopic?.reliable ? `topic:${primaryTopic.id}` : '',
  ].filter(Boolean));
  const seenCategories = new Set([primaryCategory]);
  const tags = [];

  for (const category of paper?.categories || []) {
    const label = getCategoryLabel(category);
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
    const topic = resolvePaperTopic(value);
    if (!topic) continue;
    const text = chipText(topic, label, label !== category ? label : '');
    if (seenCategories.has(category)) continue;
    // Cross-lists retain their IDs even when two arXiv categories share a name.
    if (!getArxivArchiveArea(category) && (seen.has(text.identity) || seen.has(normalizedLabel(text.label)))) continue;
    seenCategories.add(category);
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
    const topic = resolvePaperTopic(concept);
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
