import type { AIUses } from '../../services/paper-rewrite-service.ts';

/**
 * The day's uses as the card can still state them: none when the count is unknown, unlimited, from
 * before the last reset or read offline, as an old count would say what is no longer true.
 */
export function currentAIUses(quota: AIUses | null, { now, online }: { now: number; online: boolean }) {
  if (!quota?.dailyLimit || quota.unlimited || !online || !quota.resetAt || Date.parse(quota.resetAt) <= now) return null;
  return { left: quota.remainingUses, limit: quota.dailyLimit };
}
