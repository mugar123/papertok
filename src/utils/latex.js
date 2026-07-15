const HTML_ENTITIES = {
  '&amp;': '&',
  '&gt;': '>',
  '&lt;': '<',
  '&quot;': '"',
  '&#39;': "'",
};

export const LATEX_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\begin{equation}', right: '\\end{equation}', display: true },
  { left: '\\begin{align}', right: '\\end{align}', display: true },
  { left: '\\begin{eqnarray}', right: '\\end{eqnarray}', display: true },
  { left: '\\begin{math}', right: '\\end{math}', display: false },
];

function unwrapEnsureMath(match, expression, offset, source) {
  const nextCharacter = source[offset + match.length];
  const needsCommandSeparator = /\\[a-zA-Z]+$/.test(expression) && /[a-zA-Z]/.test(nextCharacter);

  return needsCommandSeparator ? `${expression} ` : expression;
}

export function normalizeLatexText(text) {
  if (!text) return '';

  return text
    .replace(/\n+/g, ' ')
    .replace(/&(?:amp|gt|lt|quot|#39);/g, entity => HTML_ENTITIES[entity] || entity)
    .replace(/\\ensuremath\{((?:\\[a-zA-Z]+|[^{}])*)\}/g, unwrapEnsureMath)
    .replace(
      /\\stackrel\{\\ifmmode\s*\\tilde\{\}\s*\\else\s*\\~\{\}\s*\\fi\{\}\}\{((?:\\[a-zA-Z]+|[^{}])+)\}/g,
      '\\tilde{$1}',
    )
    .replace(/(^|[^\\])%/g, '$1\\%');
}
