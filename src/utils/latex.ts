export type LatexChunk = { type: 'text'; value: string } | { type: 'math'; value: string; raw: string; display: boolean };

const HTML_ENTITIES: Record<string, string> = {
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

function decodeHtmlEntity(entity: string) {
  const normalizedEntity = entity.toLowerCase();
  if (HTML_ENTITIES[normalizedEntity]) return HTML_ENTITIES[normalizedEntity];
  const decimalMatch = entity.match(/^&#(\d+);$/);
  const hexMatch = entity.match(/^&#x([\da-f]+);$/i);
  const codePoint = decimalMatch ? Number(decimalMatch[1]) : hexMatch ? Number.parseInt(hexMatch[1], 16) : null;
  if (!Number.isInteger(codePoint)) return entity;

  try {
    return String.fromCodePoint(codePoint!);
  } catch {
    return entity;
  }
}

/** `text` with its named entities above, and its numeric ones, decoded. */
function decodeHtmlEntities(text: string) {
  return text.replace(/&(?:amp|gt|lt|quot|apos|nbsp|minus|le|ge|times|#39|#\d+|#x[\da-f]+);/gi, decodeHtmlEntity);
}

/**
 * JATS does not deposit a formula: it deposits one COMPLETE compilable
 * document per formula, preamble and all, inside a `<tex-math>` — and next to
 * it, in an `<alternatives>`, a MathML spelling of that same formula. Verified
 * against PMC12824388 (`fullTextXML`). The card that printed
 * `\documentclass[12pt]{minimal} \usepackage{amsmath} …` as prose was served by
 * NASA ADS, which relays the same document in a shape of its own (below).
 *
 * None of it was being removed. `SCIENTIFIC_MARKUP_TAG` wants a letter after
 * the `<`, so the CDATA markers and PMC's `<?equation-image-name …?>` outlived
 * the `<tex-math>` that explained them; and the preamble is LaTeX rather than
 * markup, so no pass here ever looked at it.
 */
const XML_COMMENT = /<!--[\s\S]*?-->/g;
const XML_PROCESSING_INSTRUCTION = /<\?[\s\S]*?\?>/g;
// ADS escapes the markers (`&lt;![CDATA[ … ]]&gt;`). Entities are decoded
// last, so an escaped marker used to slip past every pass here and only then
// turn into the `<![CDATA[` the card printed.
const CDATA_SECTION = /(?:<|&lt;)!\[CDATA\[([\s\S]*?)\]\](?:>|&gt;)/gi;
// Dropping both markers keeps the section's content and also survives the
// truncated abstract that arrives cut mid-section, with its opener orphaned.
const CDATA_MARKER = /(?:<|&lt;)!\[CDATA\[|\]\](?:>|&gt;)/gi;
const NAMESPACE = '(?:[a-z][\\w.-]*:)?';
const ALTERNATIVES = new RegExp(`<${NAMESPACE}alternatives(?:\\s[^<>]*)?>([\\s\\S]*?)</${NAMESPACE}alternatives\\s*>`, 'gi');
const TEX_MATH = new RegExp(`<${NAMESPACE}tex-math(?:\\s[^<>]*)?>([\\s\\S]*?)</${NAMESPACE}tex-math\\s*>`, 'i');
const STANDALONE_DOCUMENT = /\\documentclass[\s\S]*?\\begin\{document\}([\s\S]*?)\\end\{document\}/g;
// ADS rewrites some `_{…}` and `^{…}` inside the TeX as HTML
// (`{T}_{{{{{c}}}}}<SUP>0</SUP>`).
const HTML_SCRIPT = /<(sub|sup)>([^<]*)<\/\1>/gi;
const TRAILING_TAG = /<\/?[a-z][\w.:-]*(?:\s[^<>]*)?\/?>$/i;

/**
 * ADS also drops `\end{document}`, so the only thing left bounding the formula
 * is the CDATA section that carried it. The end is written back at that
 * boundary — never at the end of the text, which would take the rest of the
 * abstract for the formula.
 */
function closeDocument(content: string) {
  return content.includes('\\begin{document}') && !content.includes('\\end{document}')
    ? `${content}\\end{document}`
    : content;
}

/** `text` with each `<alternatives>` reduced to its `<tex-math>` spelling, when it has one. */
function preferTexAlternatives(text: string) {
  return text.replace(ALTERNATIVES, (block, body) => TEX_MATH.exec(body)?.[1] ?? body);
}

function translateScripts(formula: string) {
  return formula.replace(HTML_SCRIPT, (match, tag, content) => (
    `${tag.toLowerCase() === 'sup' ? '^' : '_'}{${content}}`
  ));
}

/**
 * Where a glued copy of `twin` starts at the end of `head`, reading through
 * any markup between its characters — ADS renders the MathML twin as HTML,
 * `T<SUB>c</SUB><SUP>0</SUP>` — or -1. Glued means glued: the twin is never
 * looked for across whitespace, which is what keeps `the ` from losing its `e`
 * to a one-letter formula that came with no twin at all.
 */
function gluedTwinStart(head: string, twin: string) {
  let end = head.length;
  for (let position = twin.length - 1; position >= 0; position -= 1) {
    while (head[end - 1] === '>') {
      const tail = head.slice(Math.max(0, end - 256), end);
      const tag = TRAILING_TAG.exec(tail);
      if (!tag) break;
      end -= tail.length - tag.index;
    }
    if (head[end - 1] !== twin[position]) return -1;
    end -= 1;
  }
  return end;
}

function stripOuterDollars(body: string) {
  const display = /^\$\$([\s\S]*)\$\$$/.exec(body);
  if (display) return display[1];
  const inline = /^\$([\s\S]*)\$$/.exec(body);
  return inline ? inline[1] : body;
}

/**
 * The MathML twin reaches us flattened to bare characters, so
 * `{T}_{{{{\rm{c}}}}}^{0}` and `Tc0` are one formula written twice.
 */
function flattenFormula(expression: string) {
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
function unwrapStandaloneDocuments(text: string) {
  let output = '';
  let cursor = 0;
  let match;

  STANDALONE_DOCUMENT.lastIndex = 0;
  while ((match = STANDALONE_DOCUMENT.exec(text)) !== null) {
    let head = output + text.slice(cursor, match.index);
    const formula = translateScripts(stripOuterDollars(match[1].trim()).trim());
    const twin = flattenFormula(formula);
    const twinStart = twin ? gluedTwinStart(head, twin) : -1;
    if (twinStart !== -1) head = head.slice(0, twinStart);
    output = `${head}\\(${formula}\\)`;
    cursor = match.index + match[0].length;
  }

  return output + text.slice(cursor);
}

export function normalizeScientificMarkup(text: unknown) {
  if (!text) return '';

  // `<alternatives>` is resolved while its tags still stand, which is what
  // makes the choice independent of the order the publisher wrote the two
  // spellings in — both orders occur in the wild.
  const chosen = preferTexAlternatives(String(text)
    .replace(XML_COMMENT, '')
    .replace(XML_PROCESSING_INSTRUCTION, '')
    .replace(CDATA_SECTION, (section, content) => closeDocument(content))
    .replace(CDATA_MARKER, ''));

  return decodeHtmlEntities(unwrapStandaloneDocuments(chosen)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(SCIENTIFIC_MARKUP_TAG, ''))
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

function isEscaped(text: string, index: number) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

/**
 * `next` keeps each delimiter's next opener for one walk, whose `startIndex`
 * only moves forward, so a delimiter is searched for again only once the walk
 * has passed it. Searched afresh for every formula, a delimiter the text lacks
 * was looked for to the end of the text each time.
 */
function findNextDelimiter(text: string, startIndex: number, next: number[]) {
  let nextMatch: { index: number; delimiter: typeof LATEX_DELIMITERS[number] } | null = null;

  for (const [position, delimiter] of LATEX_DELIMITERS.entries()) {
    let index: number | undefined = next[position];
    if (index === undefined || (index !== -1 && index < startIndex)) {
      index = text.indexOf(delimiter.left, startIndex);
      while (index !== -1 && isEscaped(text, index)) {
        index = text.indexOf(delimiter.left, index + delimiter.left.length);
      }
      next[position] = index;
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

function findDelimiterEnd(text: string, delimiter: typeof LATEX_DELIMITERS[number], startIndex: number) {
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

function commandSeparator(expression: string, nextCharacter: string | undefined) {
  const needsCommandSeparator = /\\[a-zA-Z]+$/.test(expression) && /[a-zA-Z]/.test(nextCharacter || '');
  return needsCommandSeparator ? `${expression} ` : expression;
}

function unwrapEnsureMath(match: string, expression: string, offset: number, source: string) {
  return commandSeparator(expression, source[offset + match.length]);
}

// One brace level deep is as far as OpenAlex's `\ensuremath` arguments go
// (`\ensuremath{\mathrm{*}}`); anything deeper stays as it came. A backslash
// takes the one character after it, in the argument and in its inner group
// alike, so every character has a single reading and an unclosed argument fails
// in linear time. Reading `\ab` as a macro or as `\a` and `b` backtracked
// exponentially. `\}` is an escaped brace wherever it appears, so it never
// closes the argument or its group.
const ENSUREMATH = /\\ensuremath\{((?:\\[\s\S]|[^{}\\]|\{(?:\\[\s\S]|[^{}\\])*\})*)\}/g;
/**
 * `\ifmmode A\else B\fi{}`: A is the maths spelling, B the text one. A ends at
 * the first `\else` or `\fi` and the conditional at the first `\fi`, so a scan
 * that resumes after each conditional runs in linear time. As a lazy
 * regex, a start with no `\fi` after it tried every later `\else` as its branch
 * and rescanned the rest of the text from each: cubic in unclosed conditionals.
 * `replaceMathBranch` receives A and the character after the conditional.
 */
function replaceIfmmode(value: string, replaceMathBranch: (mathBranch: string, nextCharacter: string | undefined) => string) {
  let output = '';
  let cursor = 0;

  while (cursor < value.length) {
    const start = value.indexOf('\\ifmmode', cursor);
    if (start === -1) break;
    const fi = value.indexOf('\\fi', start + '\\ifmmode'.length);
    // No later `\ifmmode` can close either.
    if (fi === -1) break;
    const body = value.slice(start + '\\ifmmode'.length, fi);
    const elseIndex = body.indexOf('\\else');
    const mathBranch = elseIndex === -1 ? body : body.slice(0, elseIndex);
    const end = value.startsWith('{}', fi + '\\fi'.length) ? fi + '\\fi{}'.length : fi + '\\fi'.length;
    output += value.slice(cursor, start) + replaceMathBranch(mathBranch, value[end]);
    cursor = end;
  }

  return output + value.slice(cursor);
}

// The argument may carry one brace level (`{\ensuremath{\gamma}}`): in prose
// it is matched BEFORE the generic `\ensuremath` pass, so that pass cannot
// have flattened it yet. Its argument reads a backslash as ENSUREMATH does.
const STACKREL_TILDE = /\\stackrel\{\\ifmmode\s*\\tilde\{\}\s*\\else\s*\\~\{\}\s*\\fi\{\}\}\{((?:\\[\s\S]|[^{}\\]|\{(?:\\[\s\S]|[^{}\\])*\})+)\}/g;

/**
 * Text-only macros with no maths spelling: the character is the whole answer.
 * `\AA{}` swallows its empty group; `\AA bond` keeps its space, because the
 * abstracts that carry these wrote the space on purpose.
 */
const TEXT_SYMBOLS: Record<string, string> = {
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

// Authors bold and italicize in the abstract (`\textbf{H}arness`, `\emph{…}`)
// and providers relay the source as written. The card paints plain prose, so
// only the wrapper goes. One brace level of argument, as ENSUREMATH; the caller
// repeats the pass to unwrap nesting. A backslash takes the one character after
// it, so every character has a single reading and an unclosed wrapper fails in
// linear time; reading `\ab` as a macro or as `\a` and `b` backtracked
// exponentially.
const FONT_COMMANDS = 'textbf|textit|textsl|textsc|textrm|textsf|textup|texttt|emph';
const TEXT_FORMATTING = new RegExp(`\\\\(?:${FONT_COMMANDS})\\{((?:\\\\[\\s\\S]|[^{}\\\\]|\\{(?:\\\\[\\s\\S]|[^{}\\\\])*\\})*)\\}`, 'g');

/** Where the delimiter walk reads a formula in `text`, delimiters included, in order. */
function formulaSpans(text: string) {
  const spans: [number, number][] = [];
  const next: number[] = [];
  for (let cursor = 0; cursor < text.length;) {
    const match = findNextDelimiter(text, cursor, next);
    if (!match) break;
    const contentEnd = findDelimiterEnd(text, match.delimiter, match.index + match.delimiter.left.length);
    if (contentEnd === -1) break;
    cursor = contentEnd + match.delimiter.right.length;
    spans.push([match.index, cursor]);
  }
  return spans;
}

/** The formulas the delimiter walk reads in `text`. Normalized text holds no newline. */
function formulaWalk(text: string, spans = formulaSpans(text)) {
  return spans.map(([start, end]) => text.slice(start, end)).join('\n');
}

const DELIMITER_STRINGS = [...new Set(LATEX_DELIMITERS.flatMap(delimiter => [delimiter.left, delimiter.right]))];
const LONGEST_DELIMITER = Math.max(...DELIMITER_STRINGS.map(delimiter => delimiter.length));
// Anything an argument could hold that is, or starts, a delimiter.
const DELIMITER_PART = /\$|\\[()[\]]|\\(?:begin|end)(?![a-zA-Z])/;
// Characters the whole-text checks may walk, per text: hundreds of checks in
// an abstract, a few in a text a hundred times longer. Past it wrappers stay.
const WALK_BUDGET = 500_000;
// One pass per level of nesting; deeper wrappers stay as written.
const NESTING_PASSES = 8;

/** Whether a delimiter reads across where `before` meets `argument` or `argument` meets `after`. */
function joinsDelimiter(before: string, argument: string, after: string) {
  const window = before + argument + after;
  const seams = [before.length, before.length + argument.length];
  return DELIMITER_STRINGS.some(delimiter => {
    for (let index = window.indexOf(delimiter); index !== -1; index = window.indexOf(delimiter, index + 1)) {
      if (seams.some(seam => index < seam && index + delimiter.length > seam)) return true;
    }
    return false;
  });
}

/**
 * Removing a wrapper must leave the formula walk reading what it read with
 * the wrapper: its braces hide a closer from `findDelimiterEnd`, and its
 * argument can hold any delimiter (`intro \[ \textbf{x \] rest} tail` is
 * prose). A wrapper whose removal changes the walk stays as written; so does a
 * wrapper inside a formula, which belongs to KaTeX, and one whose backslash is
 * escaped (`\\textbf` is a line break and a word).
 *
 * A wrapper in prose whose argument holds no delimiter and whose removal joins
 * none with the text around it cannot change the walk: its braces pair, and no
 * closer sits between them. The rest are checked against the walk of the whole
 * text, not one prose run, because removing one can assemble an opener
 * (`\begin{\textbf{equation}}`) whose closer sits past a later formula. Those
 * checks share `WALK_BUDGET` so a long text cannot take seconds, and a wrapper
 * refused once is not checked again while its argument is unchanged.
 *
 * Each pass unwraps the outermost wrappers it can, so nested ones take a pass
 * per level, up to `NESTING_PASSES`. `source` maps every character of the
 * result to its index in `value`, which is what `savedHighlightSpace` aligns
 * highlights with.
 */
function unwrapTextFormatting(value: string) {
  let formulas: string | undefined;
  let text = value;
  // By UTF-16 unit, not code point: `Array.from(value)` is shorter by one
  // for every character outside the BMP.
  let source = Array.from({ length: value.length }, (_, index) => index);
  let walked = 0;
  // The argument each refused wrapper had, by where its backslash came from.
  const refused = new Map<number, string>();
  for (let pass = 0, changed = true; changed && pass < NESTING_PASSES; pass += 1) {
    changed = false;
    // The walk is the costly part, so a text with no wrapper left skips it.
    let spans: [number, number][] | undefined;
    const output: string[] = [];
    const outputSource: number[] = [];
    // The last characters of what is already written, enough to read a
    // delimiter or an escape across the next seam.
    let tail = '';
    let cursor = 0;
    let span = 0;
    let match;
    const keep = (from: number, to: number) => {
      const piece = text.slice(from, to);
      output.push(piece);
      for (let index = from; index < to; index += 1) outputSource.push(source[index]);
      tail = (tail + piece.slice(-2 * LONGEST_DELIMITER)).slice(-2 * LONGEST_DELIMITER);
    };
    TEXT_FORMATTING.lastIndex = 0;
    while ((match = TEXT_FORMATTING.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const argument = match[1];
      if (!spans) {
        spans = formulaSpans(text);
        // Unwrapping keeps the walk, so the first one stands for every pass.
        formulas ??= formulaWalk(text, spans);
      }
      while (span < spans.length && spans[span][1] <= start) span += 1;
      const before = (start - cursor < 2 * LONGEST_DELIMITER ? tail : '')
        + text.slice(Math.max(cursor, start - 2 * LONGEST_DELIMITER), start);
      // A run of backslashes filling `before` may go on past it: keep.
      const backslashes = /\\*$/.exec(before)![0].length;
      const counted = backslashes < before.length || outputSource.length + start - cursor === before.length;
      let unwraps = backslashes % 2 === 0 && counted
        && !(span < spans.length && spans[span][0] <= start);
      if (unwraps && (DELIMITER_PART.test(argument) || joinsDelimiter(
        before.slice(-LONGEST_DELIMITER), argument, text.slice(end, end + LONGEST_DELIMITER),
      ))) {
        if (refused.get(source[start]) === argument) {
          unwraps = false;
        } else {
          walked += outputSource.length + start - cursor + argument.length + text.length - end;
          unwraps = walked <= WALK_BUDGET
            && formulaWalk(output.join('') + text.slice(cursor, start) + argument + text.slice(end)) === formulas;
          if (!unwraps) refused.set(source[start], argument);
        }
      }
      if (!unwraps) {
        TEXT_FORMATTING.lastIndex = start + 1;
        continue;
      }
      keep(cursor, start);
      // Whitespace was collapsed before unwrapping, so a removal must not join
      // two runs: the argument's edge against the space around the wrapper, or
      // the spaces either side of an empty one. The space that stays is the
      // one written first, so a control space (`\ `) keeps its own.
      let from = end - 1 - argument.length;
      if (/\s$/.test(tail)) while (from < end - 1 && /\s/.test(text[from])) from += 1;
      keep(from, end - 1);
      cursor = end;
      if (/\s$/.test(tail)) while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      changed = true;
    }
    keep(cursor, text.length);
    text = output.join('');
    source = outputSource;
  }
  // An argument's edge space at either end of the text is left over too.
  const first = text.length - text.trimStart().length;
  const last = text.trimEnd().length;
  return { text: text.slice(first, last), source: source.slice(first, last) };
}

/**
 * Applies one transform to the prose and another inside every formula, using
 * the same delimiter walk `splitLatexText` does, so "inside a formula" means
 * exactly what the renderer will later take it to mean.
 */
function transformByMode(text: string, transformProse: (text: string) => string, transformMath: (text: string) => string) {
  let output = '';
  let cursor = 0;
  const next: number[] = [];

  while (cursor < text.length) {
    const match = findNextDelimiter(text, cursor, next);
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

function normalizeMathRun(value: string) {
  return replaceIfmmode(
    value
      .replace(ENSUREMATH, unwrapEnsureMath)
      .replace(STACKREL_TILDE, '\\tilde{$1}'),
    (mathBranch, nextCharacter) => commandSeparator(mathBranch.trim(), nextCharacter),
  );
}

/**
 * APS abstracts, as OpenAlex relays them, put `\ensuremath{\sigma}` and
 * `4\ifmmode\times\else\texttimes\fi{}4` straight in the prose with no `$`
 * around them: the macro IS the formula. Each becomes its own inline formula,
 * in `\( \)` so a stray `$` in the prose cannot pair with it.
 */
function normalizeProseMacros(value: string) {
  const unwrapped = value
    .replace(STACKREL_TILDE, (match, expression) => `\\(\\tilde{${expression.replace(ENSUREMATH, '$1')}}\\)`)
    .replace(ENSUREMATH, (match, expression) => `\\(${expression}\\)`);
  return replaceIfmmode(unwrapped, (mathBranch) => `\\(${mathBranch.trim()}\\)`)
    .replace(TEXT_SYMBOL, (match, name) => TEXT_SYMBOLS[name]);
}

export function normalizeLatexText(text: unknown) {
  return unwrapTextFormatting(normalizeSavedLatexText(text)).text;
}

/** `normalizeLatexText` as it was before font commands were unwrapped. */
export function normalizeSavedLatexText(text: unknown) {
  if (!text) return '';

  return transformByMode(normalizeScientificMarkup(text), normalizeProseMacros, normalizeMathRun)
    .replace(/(^|[^\\])%/g, '$1\\%');
}

/**
 * The text highlight quotes are cut from: `normalizeLatexText` before font
 * commands are unwrapped. Quotes saved before the unwrapping hold wrappers, or
 * start or end inside one (`HERMES}, a harness`), and an unwrapped mention
 * reads exactly like a plain one with the same words, so this stays the one
 * space quotes live in. `current` is the painted text, `source` the index in
 * `text` of each of its characters, and `toCurrent` maps an offset in `text`
 * onto `current`: the number of characters before it that unwrapping kept.
 * `formulas` are the spans of `current` that `splitLatexText` hands to KaTeX.
 */
export function savedHighlightSpace(text: unknown) {
  const saved = normalizeSavedLatexText(text);
  const { text: current, source } = unwrapTextFormatting(saved);
  const offsets = new Array<number>(saved.length + 1);
  let kept = 0;
  for (let index = 0; index <= saved.length; index += 1) {
    while (kept < source.length && source[kept] < index) kept += 1;
    offsets[index] = kept;
  }
  return { text: saved, current, source, formulas: formulaSpans(current), toCurrent: (offset: number) => offsets[offset] };
}

const FONT_OPENER = new RegExp(`\\\\(?:${FONT_COMMANDS})\\{`, 'y');
const FONT_COMMAND_NAMES = FONT_COMMANDS.split('|');

/**
 * The words a stored quote paints. A quote is a slice of the saved text, so a
 * selection that starts inside a font command keeps the brace that closes it
 * (`HERMES}, a harness`) and one that ends inside keeps the command that opens
 * it (`a \textbf{harn`), as does a quote cut at the storage limit, which may
 * stop inside the command's name. The card paints none of those, so the
 * margin and the copied note drop them. A `}` is a leftover when no brace
 * before it is open, and a font command's `{` when no `}` after it closes it;
 * any other brace, escaped or paired, is the text's own. The quote alone does
 * not say which wrappers its paragraph keeps as written, so every complete
 * one unwraps here. What is stored stays as it is: the highlight finds its
 * words again through it.
 */
export function paintedQuote(quote: unknown) {
  const text = normalizeLatexText(quote);
  const cuts: [number, number][] = [];
  // Each open brace: where its font command starts and ends, or null for a plain one.
  const open: ([number, number] | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') {
      FONT_OPENER.lastIndex = index;
      const opener = FONT_OPENER.exec(text);
      if (opener) {
        open.push([index, index + opener[0].length]);
        index += opener[0].length - 1;
      } else {
        index += 1;
      }
    } else if (text[index] === '{') {
      open.push(null);
    } else if (text[index] === '}' && open.pop() === undefined) {
      cuts.push([index, index + 1]);
    }
  }
  for (const opener of open) if (opener) cuts.push(opener);
  cuts.sort((a, b) => a[0] - b[0]);
  const name = /\\([a-zA-Z]*)$/.exec(text);
  if (name && !isEscaped(text, name.index) && FONT_COMMAND_NAMES.some(command => command.startsWith(name[1]))) {
    cuts.push([name.index, text.length]);
  }

  let painted = '';
  let cursor = 0;
  for (const [from, to] of cuts) {
    painted += text.slice(cursor, from);
    cursor = to;
    // Whitespace was collapsed before, so a removal must not leave two spaces.
    if (!painted || /\s$/.test(painted)) while (/\s/.test(text[cursor] ?? '')) cursor += 1;
  }
  return (painted + text.slice(cursor)).trim();
}

/**
 * `normalizeLatexText` escapes every prose `%` to `\%` so a later LaTeX pass
 * cannot read it as a comment — but a screen (or a page of HTML) prints what
 * it is given. Prose runs go through here at paint time; the normalized space
 * itself keeps the escape, because highlight offsets are measured against it.
 */
export function displayProse(value: string) {
  return String(value).replace(/\\%/g, '%');
}

/**
 * Maps an offset in a run's *displayed* text (see `displayProse`) back to the
 * offset in its normalized source, where each `\%` occupies two characters but
 * paints as one. Identity when the run carries no escapes.
 */
export function proseSourceOffset(normalizedRun: string, displayOffset: number) {
  const run = String(normalizedRun);
  let source = 0;
  for (let display = 0; display < displayOffset && source < run.length; display += 1) {
    source += run[source] === '\\' && run[source + 1] === '%' ? 2 : 1;
  }
  return source;
}

export function splitLatexText(text: unknown) {
  const normalized = normalizeLatexText(text);
  const chunks: LatexChunk[] = [];
  let cursor = 0;
  const next: number[] = [];

  while (cursor < normalized.length) {
    const match = findNextDelimiter(normalized, cursor, next);
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
function alignRows(body: string) {
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
export function katexSource(chunk: { value?: unknown } | null | undefined) {
  const value = String(chunk?.value ?? '');

  const inline = MATH_ENV.exec(value);
  if (inline) return inline[1];

  const rows = EQNARRAY.exec(value);
  if (rows) return `\\begin{align}${alignRows(rows[1])}\\end{align}`;

  return value;
}
