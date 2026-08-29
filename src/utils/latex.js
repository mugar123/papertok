const HTML_ENTITIES = {
  '&amp;': '&',
  '&gt;': '>',
  '&lt;': '<',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&minus;': '−',
  '&le;': '≤',
  '&ge;': '≥',
  '&times;': '×',
};

const SCIENTIFIC_MARKUP_TAG = /<\/?(?:[a-z][\w.-]*:)?[a-z][\w.-]*(?:\s[^<>]*?)?\s*\/?>/gi;

function decodeHtmlEntity(entity) {
  const normalizedEntity = entity.toLowerCase();
  if (HTML_ENTITIES[normalizedEntity]) return HTML_ENTITIES[normalizedEntity];
  const decimalMatch = entity.match(/^&#(\d+);$/);
  const hexMatch = entity.match(/^&#x([\da-f]+);$/i);
  const codePoint = decimalMatch ? Number(decimalMatch[1]) : hexMatch ? Number.parseInt(hexMatch[1], 16) : null;
  if (!Number.isInteger(codePoint)) return entity;

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
}

export function normalizeScientificMarkup(text) {
  if (!text) return '';

  return String(text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(SCIENTIFIC_MARKUP_TAG, '')
    .replace(/&(?:amp|gt|lt|quot|apos|nbsp|minus|le|ge|times|#39|#\d+|#x[\da-f]+);/gi, decodeHtmlEntity)
    .replace(/\s+/g, ' ')
    .trim();
}

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

  return normalizeScientificMarkup(text)
    .replace(/\\ensuremath\{((?:\\[a-zA-Z]+|[^{}])*)\}/g, unwrapEnsureMath)
    .replace(
      /\\stackrel\{\\ifmmode\s*\\tilde\{\}\s*\\else\s*\\~\{\}\s*\\fi\{\}\}\{((?:\\[a-zA-Z]+|[^{}])+)\}/g,
      '\\tilde{$1}',
    )
    .replace(/(^|[^\\])%/g, '$1\\%');
}

/**
 * `normalizeLatexText` escapes every prose `%` to `\%` so a later LaTeX pass
 * cannot read it as a comment — but a screen (or a page of HTML) prints what
 * it is given. Prose runs go through here at paint time; the normalized space
 * itself keeps the escape, because highlight offsets are measured against it.
 */
export function displayProse(value) {
  return String(value).replace(/\\%/g, '%');
}

/**
 * Maps an offset in a run's *displayed* text (see `displayProse`) back to the
 * offset in its normalized source, where each `\%` occupies two characters but
 * paints as one. Identity when the run carries no escapes.
 */
export function proseSourceOffset(normalizedRun, displayOffset) {
  const run = String(normalizedRun);
  let source = 0;
  for (let display = 0; display < displayOffset && source < run.length; display += 1) {
    source += run[source] === '\\' && run[source + 1] === '%' ? 2 : 1;
  }
  return source;
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
