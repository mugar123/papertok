import { normalizeLatexText, splitLatexText } from './latex.js';
import { buildHighlightPlan } from './textHighlights.js';
import {
  documentCopy,
  documentMeta,
  exportFileName,
  exportableAnnotations,
  numberAnnotations,
  summarizeExport,
} from './exportDocument.js';

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
 * Mapped rather than stripped: an em dash should still read as an em dash on
 * the page. The dash and quote entries map to commands (`\textemdash{}`,
 * `\textquoteleft{}` and so on), not to the `---`/`` ` ``/`''` ligature
 * sequences that are the more obvious way to spell those characters in
 * LaTeX. That distinction is not cosmetic: compiled inside `\ptmono`
 * (`\ttfamily`, used by the running header and by `\ptorig`'s
 * original-heading line) and looked at, Latin Modern Typewriter deliberately
 * suppresses TeX's ligatures for `--`/`---` and `` ` ``/`''` — a typewriter
 * face is supposed to show the input verbatim, character for character — so
 * `Chen--` (two literal hyphens) printed instead of an em dash, and a
 * straight `"` instead of a curly quote, with nothing in the log either
 * time. A command has no such font dependence: it names the character
 * instead of hoping the active font ligates its way there, so it renders
 * correctly in both the roman and the typewriter shape, under both pdfLaTeX
 * and XeLaTeX — all four confirmed by compiling. `\S{}`, added for the same
 * reason, sidesteps a XeLaTeX-only defect one call site over: the raw `§`
 * character resolved to a Turkish dotted-g (`ğ`) inside `\ptmono` under
 * XeLaTeX specifically — again `exit=0`, nothing in the log, visible only by
 * rasterizing the page.
 */
const PUNCTUATION = {
  '\u00b7': '\\textperiodcentered{}',
  '\u2014': '\\textemdash{}',
  '\u2013': '\\textendash{}',
  '\u2018': '\\textquoteleft{}',
  '\u2019': '\\textquoteright{}',
  '\u201c': '\\textquotedblleft{}',
  '\u201d': '\\textquotedblright{}',
  '\u2026': '\\ldots{}',
  '\u2212': '-',
  '\u00d7': '\\texttimes{}',
  '\u00ab': '\\guillemotleft{}',
  '\u00bb': '\\guillemotright{}',
  '\u00a0': '~',
  '\u2009': '\\,',
  '\u2192': '\\textrightarrow{}',
  '\u00a7': '\\S{}',
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
 * such problem, so consecutive marked items are merged back into one command
 * — `\hl` for the reader's, `\dotuline` for the AI's — before being emitted,
 * otherwise a highlight that crossed a formula would come out as two commands
 * with a seam down the middle.
 */
export function renderParagraph(text, annotations = [], labels = {}) {
  const plan = buildHighlightPlan(text, annotations);
  const marked = annotations.filter(item => item?.note);
  const pieces = [];
  let run = null;

  const flush = () => {
    if (!run) return;
    const body = run.parts.join('');
    // Dos mecanismos, no dos colores: el lavado amarillo para la del lector,
    // el punteado para la de la IA. Fotocopiadas en gris, dos fondos claros
    // eran el mismo gris; un fondo y un punteado no se confunden nunca.
    const command = run.kind === 'ai' ? '\\dotuline' : '\\hl';
    // A `\footnote` inside `\hl` compiles, but the marker escapes the colour and
    // leaves a gap in it. Placed just after, it reads as one mark with a number.
    // And it is a real `\footnote`, not a marker plus a `\footnotetext` gathered
    // at the end of the document: LaTeX puts a footnote at the foot of the page
    // its marker landed on, which is the whole point. Emitting them at the end
    // put every note on the LAST page the moment there was more than one page.
    const note = marked.find(item => item.id === run.id);
    const kind = note && (note.kind === 'ai' ? labels.ai : labels.mine);
    pieces.push(note
      ? `${command}{${body}}\\footnote{\\ptkind{${escapeLatexText(kind || '')}}\\quad ${escapeLatexText(note.note)}}`
      : `${command}{${body}}`);
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
      run = { id: item.id || null, kind: item.kind || null, parts: [body] };
    }
  }
  flush();
  return pieces.join('');
}

const SECTION_FALLBACK = { es: 'Sección', en: 'Section' };

/**
 * El byline, escapado. Ya no es un `\parbox` centrado: la portada va en
 * bandera y `flushleft` parte la línea sola cuando hay nueve autores.
 */
export function authorLine(paper, limit = 12) {
  const names = (Array.isArray(paper?.authors) ? paper.authors : [])
    .map(author => String(author?.name || author || '').trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  const shown = names.slice(0, limit).map(escapeLatexText).join(', ');
  return names.length > limit ? `${shown} et al.` : shown;
}

/**
 * El rótulo de una sección, hasta `limit` caracteres, luego honestidad — el
 * mismo mecanismo que `runningTitleText` (exportDocument.js), un límite
 * distinto para la otra mitad de la misma colisión. Ver el comentario de
 * `runningTitleText` para de dónde sale el número: entre las dos, dejan hueco
 * de sobra en `\textwidth` aun en el peor caso.
 *
 * Solo alimenta el argumento CORTO de `\section[corto]{completo}` — el
 * mecanismo nativo de LaTeX para separar "lo que se ve en el texto" de "lo
 * que llega a `\sectionmark`" (y de ahí a `\leftmark`, la cabecera). El
 * título de la sección tal cual lo escribió el modelo se queda intacto en el
 * cuerpo del documento: nada en el hallazgo señala el título en pantalla,
 * solo la cabecera que arma `\leftmark` con él.
 */
export function sectionMarkText(label, limit = 30) {
  const text = String(label || '');
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
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
    // Márgenes de 27,5 mm: la medida cae en unos 72 caracteres a 11 pt, que es
    // medida de lectura. La de antes (28 mm con cuerpo menor) iba por 79.
    '\\usepackage[a4paper,top=22mm,bottom=20mm,left=27.5mm,right=27.5mm,'
      + 'headheight=14pt,headsep=10pt,footskip=22pt]{geometry}',
    '\\usepackage{xcolor}',
    ...(hasHighlights ? ['\\usepackage{soul}'] : []),
    // `normalem` no es opcional: sin él ulem redefine \emph como subrayado y
    // toda la cursiva del documento —incluidos los títulos originales— sale
    // subrayada. Compilado y mirado.
    '\\usepackage[normalem]{ulem}',
    '\\usepackage{titlesec}',
    '\\usepackage{fancyhdr}',
    '\\usepackage[hidelinks]{hyperref}',
    '',
    // El amarillo de pantalla (#FFD21E) a plena saturación detrás del texto lee
    // como una fotocopia repasada a rotulador. El lavado conserva la marca y
    // deja de gritar; la de la IA pierde el fondo y pasa a punteado, que es lo
    // que las distingue también impresas en blanco y negro.
    '\\definecolor{ptWash}{HTML}{FFE066}',
    '\\definecolor{ptGrey}{HTML}{6B7280}',
    '\\definecolor{ptRule}{HTML}{C9CCD4}',
    ...(hasHighlights ? ['\\sethlcolor{ptWash}'] : []),
    '',
    ...copy.kindNote.map(line => `% ${line}`),
    '\\newcommand{\\ptmono}{\\ttfamily}',
    '\\newcommand{\\ptkind}[1]{\\textsc{#1}}',
    // El encabezado tal como está impreso en el paper. Termina en \noindent
    // \ignorespaces porque abre párrafo y, con babel español, el siguiente
    // saldría sangrado: el primer párrafo de una sección va a bandera.
    '\\newcommand{\\ptorig}[1]{\\vspace{-5pt}\\par\\noindent'
      + '{\\ptmono\\scriptsize\\color{ptGrey}#1}\\par\\vspace{3pt}\\noindent\\ignorespaces}',
    // Sin encabezado original no se invoca \ptorig, y nada más apaga esa
    // misma sangría reactivada por babel — el primer párrafo de una sección
    // así salía sangrado mientras el de una sección con encabezado no
    // (compilado con pdflatex y mirada la página). Este macro reproduce el
    // tramo final de \ptorig un carácter a la vez —cancela el after-sep de
    // \titlespacing* con el mismo -5pt, lo sustituye por el mismo 3pt— para
    // que el hueco antes del primer párrafo no cambie entre los dos casos;
    // solo falta el texto gris de en medio, que aquí no hay. Si se retocan
    // los números de \ptorig hay que retocar estos a la vez: no hay forma de
    // que compartan la constante sin tocar \ptorig, que es justo lo que este
    // arreglo tiene prohibido.
    '\\newcommand{\\ptnoorig}{\\vspace{-5pt}\\par\\vspace{3pt}\\noindent\\ignorespaces}',
    '\\newcommand{\\ptrule}{\\noindent\\textcolor{ptRule}{\\rule{\\textwidth}{0.4pt}}}',
    '',
    // {0.62em}: con \large\bfseries, 1em deja el número descolgado del título.
    '\\titleformat{\\section}[hang]{\\normalfont\\bfseries\\large}{\\thesection}{0.62em}{}',
    '\\titlespacing*{\\section}{0pt}{18pt}{5pt}',
    '',
  ];
}

/**
 * Las dos páginas que tiene este documento.
 *
 * La primera se presenta —quién compuso esto y a qué nivel— y las demás
 * navegan: a la izquierda el artículo, a la derecha la sección en la que vas.
 * `\leftmark` da la ÚLTIMA sección abierta en la página, que es lo que quiere
 * decir «dónde estoy» cuando una sección viene de la página anterior.
 *
 * `\fancyhead[L]`/`[R]`, en el `\pagestyle{fancy}` de abajo, son dos zonas
 * sin ajuste de línea ni control de colisión propio: si lo que llevan no
 * cupiera en `\textwidth`, se imprimirían una encima de la otra sin aviso de
 * compilación. Lo que las mantiene separadas es que `meta.runningTitle`
 * (`runningTitleText`, exportDocument.js) y el argumento corto de
 * `\section[corto]{...}` (`sectionMarkText`, arriba) llegan aquí ya acotados
 * — compilado y medido, ver esas dos funciones.
 *
 * La procedencia no se mueve al colofón: sigue al pie de CADA página, fuera de
 * la numeración de las notas, porque el fichero puede acabar lejos de aquí.
 */
function pageStyles(meta) {
  const foot = escapeLatexText(meta.provenance);
  return [
    '\\renewcommand{\\sectionmark}[1]'
      + '{\\markboth{\\thesection\\ \\textperiodcentered\\ #1}{}}',
    '\\renewcommand{\\headrule}{\\color{ptRule}\\hrule height \\headrulewidth}',
    '\\renewcommand{\\footrule}{\\color{ptRule}\\hrule height \\footrulewidth}',
    '',
    '\\fancypagestyle{ptfirst}{%',
    '  \\fancyhf{}%',
    `  \\fancyhead[L]{\\ptmono\\scriptsize ${escapeLatexText(meta.masthead)}}%`,
    `  \\fancyhead[R]{\\ptmono\\scriptsize ${escapeLatexText(meta.level)}}%`,
    `  \\fancyfoot[L]{\\ptmono\\scriptsize ${foot}}%`,
    '  \\fancyfoot[R]{\\thepage}%',
    '  \\renewcommand{\\headrulewidth}{1.3pt}%',
    '  \\renewcommand{\\headrule}{\\hrule height \\headrulewidth}%',
    '  \\renewcommand{\\footrulewidth}{0.4pt}%',
    '}',
    '',
    '\\pagestyle{fancy}',
    '\\fancyhf{}',
    `\\fancyhead[L]{\\ptmono\\scriptsize ${escapeLatexText(meta.runningTitle)}}`,
    '\\fancyhead[R]{\\ptmono\\scriptsize\\leftmark}',
    `\\fancyfoot[L]{\\ptmono\\scriptsize ${foot}}`,
    '\\fancyfoot[R]{\\thepage}',
    '\\renewcommand{\\headrulewidth}{0.4pt}',
    '\\renewcommand{\\footrulewidth}{0.4pt}',
    '',
  ];
}

/**
 * Los siete caracteres que `\url` no deja pasar tal cual, escapados a la
 * manera de `\url` — que no es la manera de la prosa.
 *
 * La premisa heredada del pie de página que la Task 3 quitó era que una
 * contrabarra delante de los siete (`%#&_{}$`) bastaba. Compilado un
 * documento por carácter y mirada la página, eso es cierto solo para cuatro:
 * `%`, `#`, `&` y `_` se leen bien con `\%`, `\#`, `\&`, `\_` — es la única
 * regla que trae `url.sty` para ellos. Los otros tres, con la misma
 * contrabarra, salen mal de tres formas distintas, ninguna con aviso de
 * compilación:
 *   - `\{` imprime una contrabarra visible seguida de la llave: `\url` la
 *     lee en modo casi verbatim, así que la contrabarra no escapa nada, es
 *     un carácter más de la página.
 *   - `\}` igual.
 *   - `\$` es el peor: no imprime un signo de dólar ni una contrabarra, sino
 *     `\protect\T1\textdollar` — el mecanismo interno de hyperref para las
 *     cadenas del PDF, filtrado a la página como si fuera texto del lector.
 * Los tres se codifican en porcentaje en su lugar (`%7B`, `%7D`, `%24`): es
 * la forma canónica de escribir esos caracteres en una URL, así que el
 * enlace sigue resolviendo exactamente igual y ahora se ve bien. El `%` que
 * la codificación introduce —y cualquier `%` que ya trajera la URL— pasa
 * después por la misma regla de contrabarra que ya vale para `%`, `#`, `&`
 * y `_`.
 */
const URL_PERCENT_ENCODE = { '{': '%7B', '}': '%7D', $: '%24' };
export function escapeUrlForLatex(value) {
  return String(value ?? '')
    .replace(/[{}$]/g, character => URL_PERCENT_ENCODE[character])
    .replace(/([%#&_])/g, '\\$1');
}

/**
 * De dónde salió esto, en una tabla que se lee de un vistazo seis meses después
 * con el fichero suelto en una carpeta. Ningún campo es nuevo: todos salen del
 * modelo que ya viaja al export.
 *
 * La fila de la fuente es la excepción a `escapeLatexText`: es la única fila
 * que trae la URL cruda en vez de compuesta dentro de una frase (`meta.source`,
 * en la portada, ya la lleva metida en una oración), y por eso es aquí donde
 * vuelve el único enlace clicable que le queda al documento. La Task 3 se
 * llevó el `\url{}` que antes vivía en el pie de página; desde entonces
 * `hyperref` se cargaba sin que nada lo usara. `\url` tiene sus propias
 * reglas de escape — no son las de la prosa — y las da `escapeUrlForLatex`
 * arriba; una `~` de la URL, por ejemplo, se queda tal cual, mientras que
 * `escapeLatexText` la habría convertido en `\textasciitilde{}` e impreso el
 * comando en vez del carácter. La fila se identifica comparando su clave
 * contra `copy.colophonKeys.source`, nunca contra "Fuente" a pelo ni contra
 * su posición en el array: el documento existe en inglés también, y allí esa
 * misma clave es "Source".
 */
function colophon(meta, copy) {
  if (meta.colophon.rows.length === 0) return [];
  return [
    // Todo el bloque —desde el filete hasta la última fila de la tabla— va
    // dentro de un \minipage. Compilado un documento cuyo cuerpo termina
    // cerca del margen inferior y mirada la página: sin esto, el filete y el
    // título «Procedencia» se quedaban solos al pie de una página mientras la
    // tabla entera aparecía huérfana al principio de la siguiente, sin su
    // encabezado. Un \minipage es una caja que LaTeX nunca parte por dentro,
    // así que si el bloque completo no cabe en lo que queda de página se
    // empuja entero a la siguiente, en vez de partirse por cualquier punto
    // intermedio. `\textwidth` dentro del \minipage sigue siendo el
    // `\textwidth` de la página (un \minipage no lo redefine, solo redefine
    // `\linewidth`), así que el filete y la tabla miden exactamente lo mismo
    // que medían sin la caja alrededor.
    //
    // `\noindent` delante del `\minipage` no es cosmético: sin él, LaTeX abre
    // un párrafo nuevo para la caja y le suma la sangría de primera línea al
    // ancho de `\textwidth` que ya tiene la propia caja — compilado, eso
    // salió como «Overfull \hbox (17.0pt too wide)», los 17pt exactos de esa
    // sangría. El resto de líneas de este bloque ya llevaban su propio
    // `\noindent`; a esta le faltaba.
    '\\noindent\\begin{minipage}{\\textwidth}',
    '\\vspace{24pt}',
    '\\noindent\\rule{\\textwidth}{1.3pt}',
    '\\vspace{6pt}',
    '',
    `\\noindent{\\ptmono\\scriptsize ${escapeLatexText(meta.colophon.heading)}}`,
    '\\vspace{6pt}',
    '',
    '\\noindent\\begin{tabular}{@{}p{92pt}p{\\dimexpr\\textwidth-104pt\\relax}@{}}',
    ...meta.colophon.rows.map(row => {
      const isSource = row.key === copy.colophonKeys.source;
      const value = isSource
        ? `\\url{${escapeUrlForLatex(row.value)}}`
        : escapeLatexText(row.value);
      return `{\\ptmono\\scriptsize\\color{ptGrey}${escapeLatexText(row.key)}} & ${value} \\\\[3pt]`;
    }),
    '\\end{tabular}',
    '\\end{minipage}',
    '',
  ];
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
  generatedAt = new Date(),
  include = {},
} = {}) {
  const copy = documentCopy(language);
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
  // `ulem` is always loaded (Task 3); `soul` only backs `\hl`, and a document
  // can now hold AI marks — which render as `\dotuline`, not `\hl` — with no
  // reader marks at all. Loading `soul` for that document would be harmless,
  // but emitting `\sethlcolor` without it is a compile error, so this is the
  // one thing that needed to change: whether there is a reader mark to colour.
  const hasHighlights = kept.some(item => item.kind !== 'ai');

  const meta = documentMeta({
    paper, language, level, originalUrl, generatedAt,
    counts: summarizeExport(kept),
  });

  const lines = [
    ...preamble(copy, hasHighlights),
    ...pageStyles(meta),
    '\\begin{document}',
    '\\thispagestyle{ptfirst}',
    '',
    '\\begin{flushleft}',
    `{\\LARGE ${escapeLatexText(meta.title)}\\par}`,
    ...(meta.byline ? ['\\vspace{10pt}', `{\\large ${authorLine(paper)}\\par}`] : []),
    ...(meta.source ? ['\\vspace{5pt}', `{\\ptmono\\small ${escapeLatexText(meta.source)}\\par}`] : []),
    '\\end{flushleft}',
    '',
    // El aviso no es un abstract: no resume el paper, advierte de algo. Etiqueta
    // al margen y texto a la derecha, entre dos filetes finos.
    '\\vspace{6pt}\\ptrule\\vspace{6pt}',
    '',
    `\\noindent\\begin{minipage}[t]{58pt}\\ptmono\\scriptsize ${escapeLatexText(meta.noticeLabel)}\\end{minipage}%`,
    '\\hspace{22pt}%',
    `\\begin{minipage}[t]{\\dimexpr\\textwidth-80pt\\relax}\\small ${escapeLatexText(meta.notice)}\\end{minipage}`,
    '',
    '\\vspace{6pt}\\ptrule\\vspace{4pt}',
    '',
  ];

  for (const section of sections) {
    const label = section?.heading
      || kindLabels[section?.kind]
      || SECTION_FALLBACK[language === 'en' ? 'en' : 'es'];
    // `\section[corto]{label}` solo cuando `label` pasa el tope de
    // `sectionMarkText`: por debajo, el argumento corto sería idéntico al
    // completo y `\section{label}` de siempre ya es exactamente ese caso.
    const shortLabel = sectionMarkText(label);
    lines.push(shortLabel === label
      ? `\\section{${escapeLatexText(label)}}`
      : `\\section[${escapeLatexText(shortLabel)}]{${escapeLatexText(label)}}`);
    // El encabezado tal como está impreso en el paper. Lo devuelve el modelo
    // (`originalHeading`) y hasta ahora los dos exports lo tiraban: es lo que
    // deja volver al sitio exacto del PDF original.
    const origin = String(section?.originalHeading || '').trim();
    // Con o sin encabezado, algo tiene que apagar la sangría del primer
    // párrafo — \ptorig lo hacía como efecto colateral de imprimir el
    // encabezado; \ptnoorig hace solo eso.
    if (origin) lines.push(`\\ptorig{${escapeLatexText(origin)}}`);
    else lines.push('\\ptnoorig');
    const paragraphs = Array.isArray(section?.paragraphs) ? section.paragraphs : [];
    paragraphs.forEach((paragraph, index) => {
      const key = `${section?.id}:${index}`;
      lines.push(renderParagraph(paragraph, byParagraph.get(key) || [], copy));
      lines.push('');
    });
  }

  lines.push(...colophon(meta, copy));
  lines.push('\\end{document}');
  lines.push('');

  return {
    source: lines.join('\n'),
    fileName: exportFileName(paper, language),
    noteCount: numbered.length,
  };
}

/** The normalized paragraph text, for callers that need to match offsets. */
export function normalizedParagraph(text) {
  return normalizeLatexText(text);
}

/** Exposed for the tests: the chunks a paragraph is made of. */
export function paragraphChunks(text) {
  return splitLatexText(text);
}
