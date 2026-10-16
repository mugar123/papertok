/**
 * The email domain an institution is recognised by.
 *
 * Shared by the browser and the Worker, because the two have to agree on which
 * address a link request is about: the browser decides whether the signed-in
 * account already carries the typed domain (then no second sign-in is needed),
 * and the Worker derives the domain again from the verified address before it
 * asks the registries. If the two parsed differently, the browser could skip a
 * sign-in the Worker would then refuse.
 *
 * Lowercased, one `@`, and a domain with at least one dot: `localhost` style
 * names and display-name forms (`Alice <a@b>`) are refused rather than guessed.
 */
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function institutionDomainOf(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return '';
  const domain = value.slice(at + 1);
  return DOMAIN_PATTERN.test(domain) && domain.length <= 253 ? domain : '';
}
