import type { Paper } from '../../models/paper.ts';
import { resolveReadingLevel, type InterestSettings } from '../../utils/area-preferences.ts';
import type { ReadingLevel } from '../../utils/user-settings.ts';
import type { AIUses } from '../../services/paper-rewrite-service.ts';

interface RewriteHintOptions {
  paper: Partial<Paper>;
  interestSettings: InterestSettings;
  globalLevel: ReadingLevel;
  isCached: (level: ReadingLevel) => boolean;
  quota: AIUses | null;
  locale: string;
}

export function rewriteUseHint({ paper, interestSettings, globalLevel, isCached, quota, locale }: RewriteHintOptions) {
  const level = resolveReadingLevel(paper, interestSettings, undefined, globalLevel);
  if (isCached(level)) return 'Open this version for free.';
  if (!quota?.resetAt || quota.unlimited || Date.parse(quota.resetAt) <= Date.now()) return '';
  const reset = new Date(quota.resetAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${quota.remainingUses} AI ${quota.remainingUses === 1 ? 'use' : 'uses'} left today. Resets at ${reset}. Saved versions open free.`;
}
