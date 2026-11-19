/**
 * Whether `value` is an ORCID iD in its 16-character form, with a valid check
 * character. ORCID computes the last character with ISO 7064 MOD 11-2 over the
 * first fifteen digits, so a mistyped digit or a truncated iD fails here.
 */
export function isValidOrcidId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(value)) return false;
  const digits = value.replace(/-/g, '');
  let total = 0;
  for (const digit of digits.slice(0, 15)) total = (total + Number(digit)) * 2;
  const result = (12 - (total % 11)) % 11;
  return digits[15] === (result === 10 ? 'X' : String(result));
}

/** The ORCID registries PaperTok connects to: production, or the sandbox for testing. */
export const ORCID_HOSTS = ['orcid.org', 'sandbox.orcid.org'] as const;
export type OrcidHost = typeof ORCID_HOSTS[number];

export function isOrcidHost(value: unknown): value is OrcidHost {
  return ORCID_HOSTS.includes(value as OrcidHost);
}
