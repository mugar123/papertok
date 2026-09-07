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

/**
 * JATS does not deposit a formula: it deposits one COMPLETE compilable
 * document per formula, preamble and all, inside a `<tex-math>` — and next to
 * it, in an `<alternatives>`, a MathML spelling of that same formula. Verified
 * against PMC12824388 (`fullTextXML`), the paper whose card printed
 * `\documentclass[12pt]{minimal} \usepackage{amsmath} …` as prose.
 *
 * None of it was being removed. `SCIENTIFIC_MARKUP_TAG` wants a letter after
 * the `<`, so the CDATA markers and PMC's `<?equation-image-name …?>` outlived
 * the `<tex-math>` that explained them; and the preamble is LaTeX rather than
 * markup, so no pass here ever looked at it.
 */
const XML_COMMENT = /<!--[\s\S]*?-->/g;
const XML_PROCESSING_INSTRUCTION = /<\?[\s\S]*?\?>/g;
// Dropping both markers keeps the section's content and also survives the
// truncated abstract that arrives cut mid-section, with its opener orphaned.
const CDATA_MARKER = /<!\[CDATA\[|\]\]>/g;
const NAMESPACE = '(?:[a-z][\\w.-]*:)?';
const ALTERNATIVES = new RegExp(`<${NAMESPACE}alternatives(?:\\s[^<>]*)?>([\\s\\S]*?)</${NAMESPACE}alternatives\\s*>`, 'gi');
const TEX_MATH = new RegExp(`<${NAMESPACE}tex-math(?:\\s[^<>]*)?>([\\s\\S]*?)</${NAMESPACE}tex-math\\s*>`, 'i');
const STANDALONE_DOCUMENT = /\\documentclass[\s\S]*?\\begin\{document\}([\s\S]*?)\\end\{document\}/g;

function stripOuterDollars(body) {
  const display = /^\$\$([\s\S]*)\$\$$/.exec(body);
  if (display) return display[1];
  const inline = /^\$([\s\S]*)\$$/.exec(body);
  return inline ? inline[1] : body;
}

/**
 * The MathML twin reaches us flattened to bare characters, so
 * `{T}_{{{{\rm{c}}}}}^{0}` and `Tc0` are one formula written twice.
 */
function flattenFormula(expression) {
  return expression.replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}$_^\\\s]/g, '');
}

/**
 * Replaces each per-formula document with the formula it was compiling.
 *
 * Springer writes `$$…$$` in `<tex-math>` whether the formula is inline or
 * displayed — `114.0 mg$${}_{{\rm{NH}}_3}$$ h−1` is a subscripted unit, not an
 * equation — so those delimiters carry no display information and the formula
 * comes out inline, where the sentence expects it. In `\( \)` rather than
 * `$ $`, so a stray dollar in the prose cannot pair with it.
 *
 * A relay that already stripped the tags (Semantic Scholar) leaves no
 * `<alternatives>` to choose from, and its flattened twin arrives glued to the
 * preamble. Only the twin goes: the glued run is not always all duplicate — in
 * `114.0 mgNH3\documentclass…` the `mg` is prose and only `NH3` repeats the
 * formula — so what is dropped is the flattening of THIS formula, matched
 * exactly, or nothing at all.
 */
function unwrapStandaloneDocuments(text) {
  let output = '';
  let cursor = 0;
  let match;

  STANDALONE_DOCUMENT.lastIndex = 0;
  while ((match = STANDALONE_DOCUMENT.exec(text)) !== null) {
    let head = output + text.slice(cursor, match.index);
    const formula = stripOuterDollars(match[1].trim());
    const twin = flattenFormula(formula);
    if (twin && head.endsWith(twin)) head = head.slice(0, -twin.length);
    output = `${head}\\(${formula}\\)`;
    cursor = match.index + match[0].length;
  }

  return output + text.slice(cursor);
}

export function normalizeScientificMarkup(text) {
  if (!text) return '';

  // `<alternatives>` is resolved while its tags still stand, which is what
  // makes the choice independent of the order the publisher wrote the two
  // spellings in — both orders occur in the wild.
  const chosen = String(text)
    .replace(XML_COMMENT, '')
    .replace(XML_PROCESSING_INSTRUCTION, '')
    .replace(CDATA_MARKER, '')
    .replace(ALTERNATIVES, (block, body) => TEX_MATH.exec(body)?.[1] ?? body);

  return unwrapStandaloneDocuments(chosen)
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

const EQNARRAY = /^\\begin\{eqnarray\}([\s\S]*)\\end\{eqnarray\}$/;
const MATH_ENV = /^\\begin\{math\}([\s\S]*)\\end\{math\}$/;

/**
 * Rewrites an eqnarray body's `{rcl}` rows as the `{rl}` rows `align` sets.
 *
 * A row keeps its FIRST top-level tab — the alignment point both environments
 * share — and every later one becomes a space, so the centred relation column
 * and the right-hand side end up in one column together. Relabelling without
 * this leaves three columns, and KaTeX opens every column after the first pair
 * with a `\quad` (`alignedHandler`, katex/dist): the relation lands against the
 * left side and the right side sits a quad away, which is neither what
 * pdflatex does with the real eqnarray (it centres the relation) nor what the
 * row means. eqnarray IS `{rcl}` — a fourth column is a LaTeX error — so
 * "every tab after the first" is at most one.
 *
 * Top-level is counted, not assumed: a tab inside braces or inside a nested
 * environment belongs to that, and `\&` is a printed ampersand, never a
 * column. `\\` is only a row break at the top level too, which is what lets a
 * nested `array` keep its own rows. The pass rewrites single characters in
 * place rather than splitting and rejoining, so an optional row-spacing
 * argument (`\\[2pt]`) and every space the source chose survive it.
 */
function alignRows(body) {
  let out = '';
  let braces = 0;
  let environments = 0;
  let aligned = false;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];

    if (character === '\\') {
      const command = /^\\([a-zA-Z]+)/.exec(body.slice(index));
      if (command) {
        if (command[1] === 'begin') environments += 1;
        else if (command[1] === 'end') environments -= 1;
        out += command[0];
        index += command[0].length - 1;
        continue;
      }
      // `\\` opens a row; anything else is an escape (`\&`, `\{`) that must
      // travel with the character it escapes so neither is read on its own.
      if (body[index + 1] === '\\' && braces === 0 && environments === 0) aligned = false;
      out += character + (body[index + 1] ?? '');
      index += 1;
      continue;
    }

    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;

    if (character === '&' && braces === 0 && environments === 0) {
      out += aligned ? ' ' : '&';
      aligned = true;
      continue;
    }

    out += character;
  }

  return out;
}

/**
 * The source to hand KaTeX for a maths chunk — `value` for everything the
 * renderer already implements, a translation for the two environments it does
 * not.
 *
 * `LATEX_DELIMITERS` recognizes `\begin{eqnarray}` and `\begin{math}` because
 * older papers write them (f43ac59, "Fix legacy LaTeX rendering in paper
 * abstracts"); KaTeX implements neither and answers "No such environment" for
 * both. Every render path catches that throw and falls back to the chunk's raw
 * source as plain text, so the formula was PRINTED AS LATEX — on the card, in
 * the reader and in the exported PDF — with nothing logged. `math` is inline
 * maths and needs only its wrapper removed; `eqnarray` becomes the `align`
 * that KaTeX numbers row by row, which is also what keeps pdfExport's badge
 * counting in step with the .tex.
 *
 * Deliberately not written into the chunk: `emitMath` (latexExport.js) reads
 * `value !== raw` to decide whether a chunk still needs wrapping in
 * `\begin{equation}`, and `buildHighlightPlan` measures its offsets in
 * `value.length`. A translation stored there would wrap the align in an
 * equation and slide every highlight behind it. The .tex keeps compiling the
 * environment the paper actually wrote — base LaTeX renders eqnarray, numbers
 * included, with no amsmath needed — and only the renderer sees this.
 */
export function katexSource(chunk) {
  const value = String(chunk?.value ?? '');

  const inline = MATH_ENV.exec(value);
  if (inline) return inline[1];

  const rows = EQNARRAY.exec(value);
  if (rows) return `\\begin{align}${alignRows(rows[1])}\\end{align}`;

  return value;
}
