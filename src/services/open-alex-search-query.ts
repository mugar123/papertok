import { normalizeSearchText } from '../utils/search-relevance.ts';

/** One request carries literal, typo and unfinished-word candidates. */
export function openAlexTypeaheadExpression(query: string): string | null {
  if (!/^[a-zA-Z0-9\s:(),.!?'"–—-]+$/.test(query.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return null;
  const words = normalizeSearchText(query).split(' ').filter(Boolean);
  if (!words.length) return null;
  const phrase = `"${words.join(' ')}"`;
  if (words.length > 24 || query.length > 400) return phrase;
  const fuzzy = words.map(word => /^[a-z]{5,30}$/.test(word) ? `${word}~1` : word);
  const branches = [phrase];
  if (fuzzy.some((word, index) => word !== words[index])) branches.push(`(${fuzzy.join(' AND ')})`);
  const last = words.at(-1)!;
  if (/^[a-z]{3,}$/.test(last) && (words.length > 1 || last.length >= 4)) {
    branches.push(`(${[...fuzzy.slice(0, -1), `${last}*`].join(' AND ')})`);
  } else if (/^[a-z]{1,2}$/.test(last) && words.length >= 3) {
    branches.push(`(${fuzzy.slice(0, -1).join(' AND ')})`);
  }
  return branches.join(' OR ');
}
