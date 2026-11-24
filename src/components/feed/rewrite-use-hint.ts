import type { Paper } from '../../models/paper.ts';
import { resolveReadingLevel, type InterestSettings } from '../../utils/area-preferences.ts';
import type { ReadingLevel } from '../../utils/user-settings.ts';
import type { AIUses } from '../../services/paper-rewrite-service.ts';

interface RewriteHintOptions {
  paper: Partial<Paper>;
  interestSettings: InterestSettings;
  globalLevel: ReadingLevel;
  isCached: (level: ReadingLevel) => boolean;
}

/** Under the plain-words button, only when its version is saved and opens without spending a use; the uses left are the masthead's tag. */
export function rewriteUseHint({ paper, interestSettings, globalLevel, isCached }: RewriteHintOptions) {
  const level = resolveReadingLevel(paper, interestSettings, undefined, globalLevel);
  return isCached(level) ? 'Open this version for free.' : '';
}

/**
 * The day's uses as the card can still state them: none when the count is unknown, unlimited, from
 * before the last reset or read offline, as an old count would say what is no longer true.
 */
export function currentAIUses(quota: AIUses | null, { now, online }: { now: number; online: boolean }) {
  if (!quota?.dailyLimit || quota.unlimited || !online || !quota.resetAt || Date.parse(quota.resetAt) <= now) return null;
  return { left: quota.remainingUses, limit: quota.dailyLimit };
}
