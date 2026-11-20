import { CATEGORIES } from '../data/category-taxonomy.ts';
import type { Paper } from '../models/paper.ts';
import { areaKeyForCategory, areaKeyForPaper } from './area-accent.ts';
import { AI_EXPLANATION_LEVEL_IDS, DEFAULT_READING_PREFERENCES, type ReadingLevel } from './user-settings.ts';

export type AreaPriority = 'essential' | 'curiosity';

export const INTEREST_MIXES = {
  'mostly-work': { label: 'Mostly work', essential: 90 },
  balanced: { label: 'Balanced', essential: 75 },
  'half-and-half': { label: 'Half and half', essential: 50 },
} as const;

export type InterestMix = keyof typeof INTEREST_MIXES;
export const DEFAULT_INTEREST_MIX: InterestMix = 'balanced';

export interface AreaPreference {
  priority?: AreaPriority;
  level?: ReadingLevel;
}

export interface InterestSettings {
  interestMix?: InterestMix;
  areaPreferences?: Record<string, AreaPreference>;
}

export function normalizeInterestSettings(
  value?: { interestMix?: unknown; areaPreferences?: unknown } | null,
  areas = Object.keys(CATEGORIES),
): InterestSettings {
  const result: InterestSettings = {};
  const mix = value?.interestMix;
  if (typeof mix === 'string' && Object.hasOwn(INTEREST_MIXES, mix)) result.interestMix = mix as InterestMix;
  const stored = value?.areaPreferences;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return result;
  const entries = stored as Record<string, unknown>;
  const preferences: Record<string, AreaPreference> = {};
  for (const area of areas) {
    if (!Object.hasOwn(CATEGORIES, area) || !Object.hasOwn(entries, area)) continue;
    const entry = entries[area];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { priority, level } = entry as Record<string, unknown>;
    if (priority !== 'essential' && priority !== 'curiosity' && !AI_EXPLANATION_LEVEL_IDS.has(level)) continue;
    preferences[area] = {
      ...(priority === 'essential' || priority === 'curiosity' ? { priority } : {}),
      ...(AI_EXPLANATION_LEVEL_IDS.has(level) ? { level: level as ReadingLevel } : {}),
    };
  }
  if (Object.keys(preferences).length) result.areaPreferences = preferences;
  return result;
}

export function priorityForArea(settings: InterestSettings, area: string | null): AreaPriority {
  return (area && settings.areaPreferences?.[area]?.priority) || 'essential';
}

export function areasForInterests(topics: Iterable<string>): string[] {
  const areas = new Set<string>();
  for (const topic of topics) {
    const area = areaKeyForCategory(topic);
    if (area) areas.add(area);
  }
  return [...areas];
}

export function resolveReadingLevel(
  paper: Partial<Paper>,
  settings: InterestSettings,
  explicit?: ReadingLevel,
  globalLevel: ReadingLevel = DEFAULT_READING_PREFERENCES.aiExplanationLevel,
): ReadingLevel {
  const area = areaKeyForPaper(paper);
  return explicit ?? (area ? settings.areaPreferences?.[area]?.level : undefined) ?? globalLevel;
}
