/**
 * An author's monogram: the first letter of the first and last words that
 * start with a letter, so "J. R. R. Tolkien" is "JT" and "(Ed.)" adds nothing.
 * The Explorer's header and a shared author's preview card both show it.
 */
export function nameInitials(name: string) {
  const words = name.split(/\s+/).filter(word => /^\p{L}/u.test(word));
  if (words.length === 0) return '';
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return `${words[0][0]}${last}`.toUpperCase();
}
