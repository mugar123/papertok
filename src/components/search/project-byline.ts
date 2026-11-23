import { formatProjectAmount } from '../../utils/format-project-amount.ts';

export function projectByline(funder: string, budget: number | undefined, currency: string | undefined, locale: string) {
  return [funder, budget !== undefined && `Budget ${formatProjectAmount(budget, currency, locale)}`]
    .filter(Boolean).join(' · ');
}
