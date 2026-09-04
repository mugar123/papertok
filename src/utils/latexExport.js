import { normalizeLatexText, splitLatexText } from './latex.js';
import { buildHighlightPlan } from './textHighlights.js';

/**
 * The rewrite, as a .tex file.
 *
 * Everything here was settled by compiling, not by reasoning: the preamble, the
 * escaping, what `soul` will and will not carry. Three findings shaped it, and
 * each contradicted an assumption that looked safe:
 *
 * 1. `\setmainfont` is not usable. The reader is set in Newsreader, which the
 *    app self-hosts as a bundled webfont (`@fontsource-variable/newsreader`)
 *    — that puts a `.woff2` in the app's own bundle, not a font file on the
 *    machine that will compile this, so a `fontspec` preamble still fails
 *    outright. Latin Modern is always present, needs no declaration, and lets
 *    the file build with pdfLaTeX as well as XeLaTeX. The Newsreader line
 *    ships commented out instead.
 * 2. Spanish babel rewrites the decimal point INSIDE maths: `$0.02$` came out as
 *    `0,02`. Correct Spanish typography and a silent change to the paper's
 *    numbers, so `es-nodecimaldot` is not optional here.
 * 3. `\hl` carries inline maths and breaks across lines perfectly well —
 *    fractions, sums, roots, all of it. A highlight that spans a formula is
 *    therefore emitted as ONE `\hl`, not split at the formula's edges.
 */

/**
 * LaTeX's ten special characters, replaced in ONE pass.
 *
 * A sequence of `.split().join()` calls looks equivalent and is not: escaping
 * the backslash first inserts `\textbackslash{}`, and the brace passes that
 * follow then escape the braces it just added. Compiled and looked at, that
 * came out on the page as `\{}`. One regex with a lookup can never re-read its
 * own output.
 */
const LATEX_SPECIAL = /[\\{}$&#%_~^<>]/g;
const LATEX_ESCAPE = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '<': '\\textless{}',
  '>': '\\textgreater{}',
};

/**
 * Typographic punctuation, which UTF-8 input does NOT carry safely.
 *
 * Accented letters survive fine, which is what made this look solved. These do
 * not: compiled with pdfLaTeX and looked at, `·` came out as `û` and a curly
 * apostrophe vanished from the middle of a word without a warning. The model
 * writes em dashes and curly quotes constantly and paper titles are full of
 * them, so this is not an edge case — it is most exports.
 *
 * Mapped rather than stripped: `---` is what an em dash is in LaTeX, and the
 * page should read the way the reader read it.
 */
const PUNCTUATION = {
  '\u00b7': '\\textperiodcentered{}',
  '\u2014': '---',
  '\u2013': '--',
  '\u2018': '`',
  '\u2019': "'",
  '\u201c': '``',
  '\u201d': "''",
  '\u2026': '\\ldots{}',
  '\u2212': '-',
  '\u00d7': '\\texttimes{}',
  '\u00ab': '\\guillemotleft{}',
  '\u00bb': '\\guillemotright{}',
  '\u00a0': '~',
  '\u2009': '\\,',
  '\u2192': '\\textrightarrow{}',
};
const PUNCTUATION_RE = new RegExp(`[${Object.keys(PUNCTUATION).join('')}]`, 'g');

/**
 * Control sequences that do something other than typeset.
 *
 * Only maths reaches the file unescaped — prose is escaped character by
 * character and cannot carry a command — so this list guards exactly one hole:
 * a `$...$` written by the model, or sitting in a title fetched from an external
 * index, that reads a file, opens a shell or redefines the language.
 *
 * `\begin` and `\end` are deliberately NOT here: `\begin{aligned}` is ordinary
 * maths, and denying it would cost more legitimate formulas than it protects.
 * `\end{document}` is caught separately, as a string, because that one is only
 * ever an attempt to cut the document short.
 */
const UNSAFE_MATH = /\\(?:input|include|write|openout|openin|read|catcode|[gex]?def|let|futurelet|csname|expandafter|noexpand|immediate|special|directlua|latelua|pdfliteral|shipout|batchmode|scrollmode|nonstopmode|loop|repeat|newread|newwrite|lowercase|uppercase|aftergroup|afterassignment|usepackage|documentclass|newcommand|renewcommand|providecommand)(?![a-zA-Z])/i;

/**
 * Escapes prose for LaTeX.
 *
 * `normalizeLatexText` has already been over this text and escaped every `%` to
 * `\%`. Escaping backslashes now would turn that into a literal `\%` on the
 * page, so the pre-existing escape is undone first and the pass below is the
 * only one that ever runs. Any other backslash in prose is the model's, and
 * prose is prose: it is shown, not executed.
 */
export function escapeLatexText(value) {
  return String(value ?? '')
    .replace(/\\%/g, '%')
    .replace(LATEX_SPECIAL, character => LATEX_ESCAPE[character])
    .replace(PUNCTUATION_RE, character => PUNCTUATION[character]);
}

/** Whether a maths chunk may pass through to the file unescaped. */
export function isSafeMath(value) {
  const text = String(value ?? '');
  if (UNSAFE_MATH.test(text)) return false;
  return !/\\end\s*\{\s*document\s*\}/i.test(text);
}

/**
 * A maths chunk, wrapped the way it was written. A chunk that fails the check
 * above is not dropped and not repaired — it is escaped and shown as the source
 * it is, which is both safe and honest about what the model produced.
 */
function emitMath(item) {
  // `raw` and never `value`: for a `\begin{...}` environment `splitLatexText`
  // sets `value === raw`, delimiters and all, so re-wrapping it produced
  // `$\begin{equation}...\end{equation}$` — invalid, and it took the rest of
  // the paragraph with it. `raw` is the original slice and already carries
  // whichever delimiter the model actually wrote.
  if (!isSafeMath(item.raw)) return escapeLatexText(item.raw);
  return item.raw;
}

/**
 * One paragraph, with its highlights and the markers for its notes.
 *
 * `buildHighlightPlan` splits a range at every maths boundary, because the
 * reader's HTML cannot put a `<mark>` around KaTeX's internals. LaTeX has no
 * such problem, so consecutive marked items are merged back into one `\hl`
 * before being emitted — otherwise a highlight that crossed a formula would
 * come out as two swatches with a seam down the middle.
 */
export function renderParagraph(text, annotations = [], labels = {}) {
  const plan = buildHighlightPlan(text, annotations);
  const marked = annotations.filter(item => item?.note);
  const pieces = [];
  let run = null;

  const flush = () => {
    if (!run) return;
    const body = run.parts.join('');
    // A `\footnote` inside `\hl` compiles, but the marker escapes the colour and
    // leaves a gap in it. Placed just after, it reads as one mark with a number.
    // And it is a real `\footnote`, not a marker plus a `\footnotetext` gathered
    // at the end of the document: LaTeX puts a footnote at the foot of the page
    // its marker landed on, which is the whole point. Emitting them at the end
    // put every note on the LAST page the moment there was more than one page.
    const note = marked.find(item => item.id === run.id);
    const kind = note && (note.kind === 'ai' ? labels.ai : labels.mine);
    pieces.push(note
      ? `\\hl{${body}}\\footnote{\\ptkind{${escapeLatexText(kind || '')}}\\quad ${escapeLatexText(note.note)}}`
      : `\\hl{${body}}`);
    run = null;
  };

  for (const item of plan) {
    const isMarked = item.type === 'mark' || (item.type === 'math' && item.kind);
    const body = item.type === 'math' ? emitMath(item) : escapeLatexText(item.value);
    if (!isMarked) {
      flush();
      pieces.push(body);
      continue;
    }
    if (run && run.id === (item.id || null)) run.parts.push(body);
    else {
      flush();
      run = { id: item.id || null, parts: [body] };
    }
  }
  flush();
  return pieces.join('');
}

const SECTION_FALLBACK = { es: 'Sección', en: 'Section' };

const COPY = {
  es: {
    babel: 'spanish,es-nodecimaldot,es-noquoting',
    stamp: level => `Versión en lenguaje sencillo · nivel ${level}`,
    abstract: 'Reescritura en lenguaje sencillo del artículo original, generada automáticamente y anotada por el lector. El texto de abajo no es obra del autor del artículo: parafrasea sus resultados y no los sustituye.',
    provenance: 'Reescrito por PaperTok. No es obra de sus autores',
    mine: 'Tuya',
    ai: 'IA',
    levels: { beginner: 'principiante', university: 'universitario', researcher: 'investigador' },
    fontHint: 'Descomenta las dos líneas siguientes si tienes Newsreader instalada.',
    kindNote: ['El marcador de una nota es el mismo venga de quien venga; lo que las', 'distingue es la etiqueta con la que empieza la nota.'],
    footerNote: ['La procedencia no es una de las notas: va al pie de CADA página, fuera', 'de la numeración, porque el fichero puede acabar lejos de aquí.'],
    generated: 'Generado por PaperTok. Compila con pdflatex o xelatex.',
  },
  en: {
    babel: 'english',
    stamp: level => `Plain-language version · ${level} level`,
    abstract: 'A plain-language rewrite of the original article, generated automatically and annotated by its reader. The text below is not the work of the article’s author: it paraphrases the results and does not replace them.',
    provenance: 'Rewritten by PaperTok. Not the work of its authors',
    mine: 'Yours',
    ai: 'AI',
    levels: { beginner: 'beginner', university: 'university', researcher: 'researcher' },
    fontHint: 'Uncomment the next two lines if you have Newsreader installed.',
    kindNote: ['A note\'s marker is the same whoever wrote it; what tells them apart', 'is the label the note itself starts with.'],
    footerNote: ['Provenance is not one of the notes: it sits at the foot of EVERY page,', 'outside their numbering, because this file can end up a long way from here.'],
    generated: 'Generated by PaperTok. Compile with pdflatex or xelatex.',
  },
};

export function authorLine(paper, limit = 12) {
  const authors = Array.isArray(paper?.authors) ? paper.authors : [];
  const names = authors
    .map(author => String(author?.name || author || '').trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  const shown = names.slice(0, limit).map(escapeLatexText);
  const line = names.length > limit ? `${shown.join(', ')} et al.` : shown.join(', ');
  // `\and` would set them in columns and `\author` alone sets them on one line
  // that runs off the page — nine names is an ordinary paper. A centred parbox
  // at 90% of the measure wraps them and keeps the byline a byline.
  return `\\parbox{0.9\\textwidth}{\\centering ${line}}`;
}

/**
 * A filename the operating system will accept, derived from the title so the
 * download is recognisable in a folder six months later.
 */
export function exportFileName(paper, language = 'es', extension = 'tex') {
  const stem = String(paper?.title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const suffix = language === 'en' ? 'plain-words' : 'en-simple';
  return `${stem || 'paper'}-${suffix}.${extension}`;
}

/**
 * The document's words, shared with the PDF export so the two formats can
 * never drift apart: one provenance line, one stamp, one pair of note labels.
 */
export function documentCopy(language = 'es') {
  return COPY[language === 'en' ? 'en' : 'es'];
}

function preamble(copy, hasHighlights) {
  return [
    `% ${copy.generated}`,
    '\\documentclass[11pt,a4paper]{article}',
    '',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{lmodern}',
    `% ${copy.fontHint}`,
    '% \\usepackage{fontspec}',
    '% \\setmainfont{Newsreader}',
    `\\usepackage[${copy.babel}]{babel}`,
    '\\usepackage[a4paper,margin=28mm,bottom=34mm]{geometry}',
    ...(hasHighlights ? ['\\usepackage{soul}', '\\usepackage{xcolor}'] : []),
    '\\usepackage[hidelinks]{hyperref}',
    '\\usepackage{fancyhdr}',
    '',
    ...(hasHighlights
      ? [
        '\\definecolor{ptYellow}{HTML}{FFD21E}',
        '\\definecolor{ptGrey}{HTML}{F0F0F1}',
        '\\sethlcolor{ptYellow}',
        '',
      ]
      : []),
    ...copy.kindNote.map(line => `% ${line}`),
    '\\newcommand{\\ptkind}[1]{\\texttt{\\footnotesize #1}}',
    '',
  ];
}

function footer(copy, originalUrl) {
  const link = originalUrl
    ? ` \\textperiodcentered{} \\url{${originalUrl.replace(/([%#&_{}$])/g, '\\$1')}}`
    : '';
  return [
    ...copy.footerNote.map(line => `% ${line}`),
    '\\pagestyle{fancy}',
    '\\fancyhf{}',
    `\\fancyfoot[L]{\\footnotesize ${escapeLatexText(copy.provenance)}${link}}`,
    '\\fancyfoot[R]{\\thepage}',
    '\\renewcommand{\\headrulewidth}{0pt}',
    '',
  ];
}

/**
 * Numbers every annotation that carries words, in document order, and hands
 * back a lookup by paragraph. A bare highlight has nothing to say in a footnote
 * and is not given a number — it is just colour on the page.
 */
export function numberAnnotations(sections, annotations) {
  const order = new Map();
  sections.forEach((section, index) => order.set(String(section?.id), index));
  const placed = annotations
    .filter(item => item && item.quote)
    .map((item, arrival) => ({ item, arrival }))
    .sort((left, right) => {
      const ls = order.has(String(left.item.sectionId)) ? order.get(String(left.item.sectionId)) : Number.MAX_SAFE_INTEGER;
      const rs = order.has(String(right.item.sectionId)) ? order.get(String(right.item.sectionId)) : Number.MAX_SAFE_INTEGER;
      if (ls !== rs) return ls - rs;
      const lp = Number(left.item.paragraphIndex) || 0;
      const rp = Number(right.item.paragraphIndex) || 0;
      if (lp !== rp) return lp - rp;
      return left.arrival - right.arrival;
    });

  const byParagraph = new Map();
  const numbered = [];
  for (const { item } of placed) {
    const entry = { ...item };
    if (item.note) {
      entry.number = numbered.length + 1;
      numbered.push(entry);
    }
    const key = `${item.sectionId}:${Number(item.paragraphIndex) || 0}`;
    byParagraph.set(key, [...(byParagraph.get(key) || []), entry]);
  }
  return { byParagraph, numbered };
}

/**
 * The annotations this rewrite can actually carry.
 *
 * The rail holds every annotation for the paper, at any level and in any
 * language; the marks in the text are filtered to the rewrite on screen. An
 * export that used the rail's list put notes written on other words into a
 * document that no longer contains them — anchored by quote, a note only means
 * anything in the rewrite it was made on.
 *
 * An annotation with no level recorded predates the field and is kept: dropping
 * it would delete history rather than filter it.
 */
export function exportableAnnotations(annotations = [], { sections = [], level, language } = {}) {
  const known = new Set(sections.map(section => String(section?.id)));
  const wanted = language === 'en' ? 'en' : 'es';
  return annotations.filter(item => {
    if (!item?.quote) return false;
    if (level && item.level && item.level !== level) return false;
    if (item.language && item.language !== wanted) return false;
    return known.has(String(item.sectionId));
  });
}

/**
 * @returns {{ source: string, fileName: string, noteCount: number }}
 */
export function buildLatexDocument({
  paper,
  sections = [],
  annotations = [],
  language = 'es',
  level = 'university',
  kindLabels = {},
  originalUrl = '',
  include = {},
} = {}) {
  const copy = COPY[language === 'en' ? 'en' : 'es'];
  const wantMarks = include.marks !== false;
  const wantMine = include.mine !== false;
  const wantAi = include.ai !== false;

  const kept = exportableAnnotations(annotations, { sections, level, language })
    .filter(item => {
      if (item.kind === 'ai') return wantAi;
      // A bare highlight is a mark; a highlight with words on it is a note. The
      // two switches are separate because wanting one is not wanting the other.
      return item.note ? wantMine : wantMarks;
    });

  const { byParagraph, numbered } = numberAnnotations(sections, kept);
  const hasHighlights = kept.length > 0;

  const lines = [
    ...preamble(copy, hasHighlights),
    ...footer(copy, originalUrl),
    `\\title{${escapeLatexText(paper?.title || '')}}`,
    `\\author{${authorLine(paper)}}`,
    `\\date{${escapeLatexText(copy.stamp(copy.levels[level] || level))}}`,
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\begin{abstract}',
    escapeLatexText(copy.abstract),
    '\\end{abstract}',
    '',
  ];

  for (const section of sections) {
    const label = section?.heading
      || kindLabels[section?.kind]
      || SECTION_FALLBACK[language === 'en' ? 'en' : 'es'];
    lines.push(`\\section{${escapeLatexText(label)}}`);
    const paragraphs = Array.isArray(section?.paragraphs) ? section.paragraphs : [];
    paragraphs.forEach((paragraph, index) => {
      const key = `${section?.id}:${index}`;
      lines.push(renderParagraph(paragraph, byParagraph.get(key) || [], copy));
      lines.push('');
    });
  }

  lines.push('\\end{document}');
  lines.push('');

  return {
    source: lines.join('\n'),
    fileName: exportFileName(paper, language),
    noteCount: numbered.length,
  };
}

/** What the export card counts, without building the document to find out. */
export function summarizeExport(annotations = []) {
  let marks = 0;
  let mine = 0;
  let ai = 0;
  for (const item of annotations) {
    if (!item?.quote) continue;
    if (item.kind === 'ai') ai += 1;
    else if (item.note) mine += 1;
    else marks += 1;
  }
  return { marks, mine, ai };
}

/** The normalized paragraph text, for callers that need to match offsets. */
export function normalizedParagraph(text) {
  return normalizeLatexText(text);
}

/** Exposed for the tests: the chunks a paragraph is made of. */
export function paragraphChunks(text) {
  return splitLatexText(text);
}
