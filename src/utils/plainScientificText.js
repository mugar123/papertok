import { displayProse, splitLatexText } from './latex.js';

/**
 * A scientific title or summary as plain text, for the places that cannot
 * render KaTeX: a share preview, a `<title>`, the text a share sheet sends.
 *
 * Built on `splitLatexText`, so the delimiters, OpenAlex's text-mode macros
 * and provider markup are read exactly as the card reads them. A math run
 * keeps its letters and turns what has a character of its own into that
 * character (`\alpha` → α, `^{212}` → ²¹²); anything else loses only its
 * markup, so the result is readable rather than exact.
 */

const SYMBOLS = Object.freeze({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  infty: '∞', sim: '~', approx: '≈', simeq: '≃', leq: '≤', le: '≤', geq: '≥', ge: '≥',
  neq: '≠', ne: '≠', times: '×', cdot: '·', pm: '±', mp: '∓', to: '→', rightarrow: '→',
  leftarrow: '←', leftrightarrow: '↔', partial: '∂', nabla: '∇', sqrt: '√', sum: '∑',
  prod: '∏', int: '∫', ell: 'ℓ', hbar: 'ħ', ldots: '…', dots: '…', cdots: '⋯', circ: '∘',
  in: '∈', subset: '⊂', cup: '∪', cap: '∩', langle: '⟨', rangle: '⟩', prime: '′',
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan', min: 'min', max: 'max',
});

const SUPERSCRIPTS = Object.freeze({
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
});
const SUBSCRIPTS = Object.freeze({
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
});

// A command whose argument is the text itself: `\mathcal{C}` is a C.
const WRAPPERS = /\\(?:mathcal|mathbb|mathrm|mathbf|mathit|mathsf|mathtt|mathfrak|mathscr|boldsymbol|bm|text|textrm|textit|textbf|operatorname|mbox|hat|bar|tilde|vec|dot|ddot|widehat|widetilde|overline|underline)\s*\{([^{}]*)\}/g;

function script(content, table, marker) {
  const characters = [...content];
  return characters.length > 0 && characters.every(character => table[character])
    ? characters.map(character => table[character]).join('')
    : `${marker}${content}`;
}

function plainMath(source) {
  let text = String(source);
  // Innermost first, so `\mathbf{\hat{x}}` unwraps one layer per pass.
  for (let pass = 0; pass < 4; pass += 1) {
    const unwrapped = text.replace(WRAPPERS, '$1');
    if (unwrapped === text) break;
    text = unwrapped;
  }
  return text
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√$1')
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\([A-Za-z]+)/g, (match, name) => (SYMBOLS[name] !== undefined ? SYMBOLS[name] : name))
    .replace(/\^\{([^{}]*)\}|\^(\S)/g, (match, group, single) => script(group ?? single, SUPERSCRIPTS, '^'))
    .replace(/_\{([^{}]*)\}|_(\S)/g, (match, group, single) => script(group ?? single, SUBSCRIPTS, '_'))
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '');
}

// The inline tags providers leave in titles and abstracts, and nothing else:
// a comparison sign is prose. A pattern that took any `<…>` for a tag emptied
// «(P < .001) compared with … (P > .05)» of everything between the signs, the
// bug this audit had fixed in the Europe PMC reader (review of 2026-09-25).
// Attributes have to look like attributes, too.
const INLINE_TAG = /<\/?(?:i|b|em|strong|sup|sub|span|a|u|small|abbr|italic|bold|sc)(?:\s+[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>/gi;

function plainProse(source) {
  return displayProse(source)
    .replace(INLINE_TAG, '')
    .replace(/\\([&#$_{}])/g, '$1');
}

export function plainScientificText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!text.trim()) return '';
  return splitLatexText(text)
    .map(chunk => (chunk.type === 'math' ? plainMath(chunk.value) : plainProse(chunk.value)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
