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

function isEscaped(text, index) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function findNextDelimiter(text, startIndex) {
  let nextMatch = null;

  for (const delimiter of LATEX_DELIMITERS) {
    let index = text.indexOf(delimiter.left, startIndex);
    while (index !== -1 && isEscaped(text, index)) {
      index = text.indexOf(delimiter.left, index + delimiter.left.length);
    }

    if (
      index !== -1
      && (
        !nextMatch
        || index < nextMatch.index
        || (index === nextMatch.index && delimiter.left.length > nextMatch.delimiter.left.length)
      )
    ) {
      nextMatch = { index, delimiter };
    }
  }

  return nextMatch;
}

function findDelimiterEnd(text, delimiter, startIndex) {
  let braceLevel = 0;

  for (let index = startIndex; index < text.length; index += 1) {
    if (
      braceLevel <= 0
      && text.startsWith(delimiter.right, index)
      && !isEscaped(text, index)
    ) {
      return index;
    }

    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === '{') {
      braceLevel += 1;
    } else if (text[index] === '}') {
      braceLevel -= 1;
    }
  }

  return -1;
}

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

export function splitLatexText(text) {
  const normalized = normalizeLatexText(text);
  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const match = findNextDelimiter(normalized, cursor);
    if (!match) {
      chunks.push({ type: 'text', value: normalized.slice(cursor) });
      break;
    }

    if (match.index > cursor) {
      chunks.push({ type: 'text', value: normalized.slice(cursor, match.index) });
    }

    const contentStart = match.index + match.delimiter.left.length;
    const contentEnd = findDelimiterEnd(normalized, match.delimiter, contentStart);
    if (contentEnd === -1) {
      chunks.push({ type: 'text', value: normalized.slice(match.index) });
      break;
    }

    const raw = normalized.slice(match.index, contentEnd + match.delimiter.right.length);
    const isEnvironment = match.delimiter.left.startsWith('\\begin{');
    chunks.push({
      type: 'math',
      value: isEnvironment ? raw : normalized.slice(contentStart, contentEnd),
      raw,
      display: match.delimiter.display,
    });
    cursor = contentEnd + match.delimiter.right.length;
  }

  return chunks;
}
