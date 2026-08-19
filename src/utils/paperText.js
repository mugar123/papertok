/**
 * Display-side cleanup for paper metadata that arrives dirty from its source.
 *
 * Some interaction documents predate any normalization: titles carry literal
 * HTML (`La <sub>2</sub> CuO <sub>4</sub>`) and author names arrive in
 * "Surname, I." order. The stored documents are deliberately NOT rewritten —
 * that migration is tracked as data debt (R8) — so every consumer that wants
 * clean text cleans it at paint time through these helpers.
 */

const SUBSCRIPT = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋' };
const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

function mapScript(content, table) {
  const characters = [...content];
  if (!characters.every(character => table[character])) return null;
  return characters.map(character => table[character]).join('');
}

/**
 * Strips literal HTML from a title while keeping what it meant. `<sub>`/`<sup>`
 * with simple numeric content become Unicode sub/superscripts glued to their
 * neighbours ("La <sub>2</sub> CuO" → "La₂CuO", the chemistry the markup was
 * spelling); any other tag is dropped and its content kept. LaTeX (`$...$`)
 * passes through untouched — rendering it is `ScientificText`'s job.
 */
export function cleanPaperText(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);

  text = text.replace(/\s*<(sub|sup)\b[^>]*>([\s\S]*?)<\/\1>/gi, (match, tag, content) => {
    const table = tag.toLowerCase() === 'sub' ? SUBSCRIPT : SUPERSCRIPT;
    const mapped = mapScript(content.trim(), table);
    // Non-numeric scripts keep their content, spaced normally.
    return mapped ?? ` ${content.trim()} `;
  });
  // A subscript followed by a capitalized token is a formula still going
  // ("La₂ CuO₄" → "La₂CuO₄"); superscripts are left alone because they end
  // expressions more often than they continue them ("mc² Revisited").
  text = text.replace(/([₀₁₂₃₄₅₆₇₈₉₊₋])\s+(?=\p{Lu})/gu, '$1');

  text = text.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, ' ');
  text = text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => ENTITIES[entity]);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Flips "Surname, I." (initials only) into "I. Surname". Anything that is not
 * unambiguously that pattern — full given names, multiple commas, suffixes —
 * is returned untouched, because guessing wrong corrupts a real name.
 */
export function displayAuthorName(value) {
  if (value === null || value === undefined) return '';
  const name = String(value).replace(/\s+/g, ' ').trim();
  const match = name.match(/^(\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+)*), ((?:\p{Lu}\.(?: ?|$))+)$/u);
  if (!match) return name;
  const [, surname, initials] = match;
  return `${initials.trim()} ${surname}`;
}
