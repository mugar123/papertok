/**
 * A project's budget or funded amount as text. An unknown currency (Graph
 * returns null for some funders, such as SNSF) stays unknown: the plain
 * number is shown, never a guessed symbol.
 */
export function formatProjectAmount(amount: number, currency: string | undefined, locale: string) {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return amount.toLocaleString(locale);
  }
}
