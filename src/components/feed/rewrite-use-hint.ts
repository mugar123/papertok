import type { AIUses } from '../../services/paper-rewrite-service.ts';

export function rewriteUseHint(quota: AIUses | null, cached: boolean, locale: string) {
  if (cached) return 'Open this version for free.';
  if (!quota?.resetAt || quota.unlimited || Date.parse(quota.resetAt) <= Date.now()) return '';
  const reset = new Date(quota.resetAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${quota.remainingUses} AI ${quota.remainingUses === 1 ? 'use' : 'uses'} left today. Resets at ${reset}. Saved versions open free.`;
}
