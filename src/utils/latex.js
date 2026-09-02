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

function commandSeparator(expression, nextCharacter) {
  const needsCommandSeparator = /\\[a-zA-Z]+$/.test(expression) && /[a-zA-Z]/.test(nextCharacter || '');
  return needsCommandSeparator ? `${expression} ` : expression;
}

function unwrapEnsureMath(match, expression, offset, source) {
  return commandSeparator(expression, source[offset + match.length]);
}

// One brace level deep is as far as OpenAlex's `\ensuremath` arguments go
// (`\ensuremath{\mathrm{*}}`); anything deeper stays as it came.
const ENSUREMATH = /\\ensuremath\{((?:\\[a-zA-Z]+|[^{}]|\{[^{}]*\})*)\}/g;
// `\ifmmode A\else B\fi{}`: A is the maths spelling, B the text one.
const IFMMODE = /\\ifmmode\s*([\s\S]*?)(?:\\else\s*([\s\S]*?))?\\fi(?:\{\})?/g;
// The argument may carry one brace level (`{\ensuremath{\gamma}}`): in prose
// it is matched BEFORE the generic `\ensuremath` pass, so that pass cannot
// have flattened it yet.
const STACKREL_TILDE = /\\stackrel\{\\ifmmode\s*\\tilde\{\}\s*\\else\s*\\~\{\}\s*\\fi\{\}\}\{((?:\\[a-zA-Z]+|[^{}]|\{[^{}]*\})+)\}/g;

/**
 * Text-only macros with no maths spelling: the character is the whole answer.
 * `\AA{}` swallows its empty group; `\AA bond` keeps its space, because the
 * abstracts that carry these wrote the space on purpose.
 */
const TEXT_SYMBOLS = {
  AA: 'Å',
  textcopyright: '©',
  texttimes: '×',
  textdegree: '°',
  textmu: 'µ',
  textpm: '±',
  textperiodcentered: '·',
  textellipsis: '…',
  textendash: '–',
  textemdash: '—',
  textquoteleft: '‘',
  textquoteright: '’',
  textquotedblleft: '“',
  textquotedblright: '”',
  textasciitilde: '~',
};
const TEXT_SYMBOL = new RegExp(`\\\\(${Object.keys(TEXT_SYMBOLS).join('|')})(?![a-zA-Z])(?:\\{\\})?`, 'g');

/**
 * Applies one transform to the prose and another inside every formula, using
 * the same delimiter walk `splitLatexText` does, so "inside a formula" means
 * exactly what the renderer will later take it to mean.
 */
function transformByMode(text, transformProse, transformMath) {
  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const match = findNextDelimiter(text, cursor);
    if (!match) {
      output += transformProse(text.slice(cursor));
      break;
    }
    if (match.index > cursor) {
      output += transformProse(text.slice(cursor, match.index));
    }
    const contentStart = match.index + match.delimiter.left.length;
    const contentEnd = findDelimiterEnd(text, match.delimiter, contentStart);
    if (contentEnd === -1) {
      output += transformProse(text.slice(match.index));
      break;
    }
    output += match.delimiter.left
      + transformMath(text.slice(contentStart, contentEnd))
      + match.delimiter.right;
    cursor = contentEnd + match.delimiter.right.length;
  }

  return output;
}

function normalizeMathRun(value) {
  return value
    .replace(ENSUREMATH, unwrapEnsureMath)
    .replace(STACKREL_TILDE, '\\tilde{$1}')
    .replace(IFMMODE, (match, mathBranch, textBranch, offset, source) => (
      commandSeparator(mathBranch.trim(), source[offset + match.length])
    ));
}

/**
 * APS abstracts, as OpenAlex relays them, put `\ensuremath{\sigma}` and
 * `4\ifmmode\times\else\texttimes\fi{}4` straight in the prose with no `$`
 * around them: the macro IS the formula. Each becomes its own inline formula,
 * in `\( \)` so a stray `$` in the prose cannot pair with it.
 */
function normalizeProseRun(value) {
  return value
    .replace(STACKREL_TILDE, (match, expression) => `\\(\\tilde{${expression.replace(ENSUREMATH, '$1')}}\\)`)
    .replace(ENSUREMATH, (match, expression) => `\\(${expression}\\)`)
    .replace(IFMMODE, (match, mathBranch) => `\\(${mathBranch.trim()}\\)`)
    .replace(TEXT_SYMBOL, (match, name) => TEXT_SYMBOLS[name]);
}

export function normalizeLatexText(text) {
  if (!text) return '';

  return transformByMode(normalizeScientificMarkup(text), normalizeProseRun, normalizeMathRun)
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
