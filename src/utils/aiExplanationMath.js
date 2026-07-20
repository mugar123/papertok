const GREEK_LATEX = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', η: '\\eta', θ: '\\theta',
  λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma',
  τ: '\\tau', φ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi',
  Σ: '\\Sigma', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
};

const MATH_SEGMENT = /(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;
const RAW_SUBSCRIPT = /(?:([A-Za-z])|([αβγδεηθλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ]))_([A-Za-z0-9]+)/g;
const RAW_SUPERSCRIPT = /(?:([A-Za-z])|([αβγδεηθλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ]))\^([A-Za-z0-9]+)/g;

function normalizePlainSegment(segment) {
  const toLatex = (match, latin, greek, suffix, operator) => {
    const symbol = greek ? GREEK_LATEX[greek] : latin;
    return `$${symbol}${operator}{${suffix}}$`;
  };

  return segment
    .replace(RAW_SUBSCRIPT, (match, latin, greek, suffix) => toLatex(match, latin, greek, suffix, '_'))
    .replace(RAW_SUPERSCRIPT, (match, latin, greek, suffix) => toLatex(match, latin, greek, suffix, '^'));
}

// Gemini sometimes returns Unicode symbols with raw sub/superscripts despite the requested delimiters.
// Preserve valid LaTeX and repair only the plain-text fragments around it.
export function normalizeAIExplanationMath(value) {
  return String(value || '')
    .split(MATH_SEGMENT)
    .map((segment, index) => (index % 2 === 0 ? normalizePlainSegment(segment) : segment))
    .join('');
}
