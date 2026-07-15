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

export function normalizeLatexText(text) {
  if (!text) return '';

  return text
    .replace(/\n+/g, ' ')
    .replace(/&(?:amp|gt|lt|quot|#39);/g, entity => HTML_ENTITIES[entity] || entity)
    .replace(/\\ensuremath\{((?:\\[a-zA-Z]+|[^{}])*)\}/g, '$1')
    .replace(
      /\\stackrel\{\\ifmmode\s*\\tilde\{\}\s*\\else\s*\\~\{\}\s*\\fi\{\}\}\{((?:\\[a-zA-Z]+|[^{}])+)\}/g,
      '\\tilde{$1}',
    )
    .replace(/(^|[^\\])%/g, '$1\\%');
}
