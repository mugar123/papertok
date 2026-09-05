import {
  documentCopy,
  documentMeta,
  exportFileName,
  exportableAnnotations,
  numberAnnotations,
  sectionMarkText,
  summarizeExport,
} from './exportDocument.js';
import { displayProse } from './latex.js';
import { isNumberedFormula } from './latexExport.js';
import { buildHighlightPlan } from './textHighlights.js';
import { loadKatex } from './katexLoader.js';

/**
 * The rewrite, as a .pdf.
 *
 * The Worker cannot compile LaTeX and the browser cannot either, so this is
 * not the .tex run through a compiler: it is the same document — the same
 * filtering, the same numbering, the same words, all shared with
 * `latexExport.js` — laid out as A4 pages of real DOM, rasterized page by
 * page and bound into a PDF on the reader's own machine. Nothing about the
 * paper or the notes leaves the page to make the file.
 *
 * Two things this format does that the .tex cannot: it sets the text in
 * Newsreader (the reader's own face, self-hosted, which no LaTeX toolchain
 * elsewhere can be assumed to have), and it can tell an AI mark from the
 * reader's the way the export card's preview promises — a dotted underline
 * versus the brand yellow wash.
 *
 * The model half of this file is pure and tested under node; everything from
 * `renderPdfPages` down needs a DOM and is verified live.
 */

const SECTION_FALLBACK = { es: 'Sección', en: 'Section' };

/**
 * Everything the pages need, decided before any DOM exists. The include
 * switches and the numbering follow `buildLatexDocument` exactly: an export
 * that filtered differently by format would put different notes in the two
 * files a reader believes are the same document.
 *
 * `meta` is `documentMeta`'s own return value, mounted whole rather than
 * spread into loose fields at the root: the .tex and the PDF build their
 * frame — title, byline, notice, provenance, colophon — from the exact same
 * object, so the two formats cannot describe the document differently by
 * accident. `plainAuthorLine`, the field-by-field version of this that used
 * to live here, is gone: `bylineText` in `exportDocument.js` does that job
 * now, for both formats at once.
 *
 * @returns {{
 *   meta: { masthead: string, level: string, title: string, byline: string, source: string,
 *     noticeLabel: string, notice: string, provenance: string, runningTitle: string,
 *     colophon: { heading: string, rows: Array<{ key: string, value: string }> } },
 *   language: string,
 *   labels: { mine: string, ai: string },
 *   sections: Array<{ label: string, runningLabel: string, originalHeading: string, paragraphs: Array<{ text: string, annotations: Array<object> }> }>,
 *   noteCount: number, fileName: string,
 * }}
 */
export function buildPdfModel({
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
  const kept = exportableAnnotations(annotations, {
    sections, level, language, include,
  });

  const { byParagraph, numbered } = numberAnnotations(sections, kept);
  const fallback = SECTION_FALLBACK[language === 'en' ? 'en' : 'es'];

  return {
    meta: documentMeta({
      paper, language, level, originalUrl, generatedAt, counts: summarizeExport(kept),
    }),
    language: language === 'en' ? 'en' : 'es',
    labels: { mine: copy.mine, ai: copy.ai },
    sections: sections.map(section => {
      const label = section?.heading || kindLabels[section?.kind] || fallback;
      return {
        label,
        // Solo para el titulillo (`buildBlocks`, abajo): el mismo tope que
        // el `.tex` aplica al argumento corto de `\section[corto]{...}` —
        // `sectionMarkText`, exportDocument.js — para la misma colisión,
        // esta vez contra `meta.runningTitle` en la cabecera del PDF. El
        // rótulo de arriba, el que de verdad se lee en la página, se queda
        // intacto: el hallazgo fue un titulillo envuelto a dos líneas, no
        // un encabezado ilegible en el cuerpo.
        runningLabel: sectionMarkText(label),
        originalHeading: String(section?.originalHeading || '').trim(),
        paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
          .map((text, index) => ({
            text,
            annotations: byParagraph.get(`${section?.id}:${index}`) || [],
          })),
      };
    }),
    noteCount: numbered.length,
    fileName: exportFileName(paper, language, 'pdf'),
  };
}

/* ── From here on, browser only ─────────────────────────────────────────── */

/**
 * A4 at 96 dpi. The rasterizer captures at scale 2, so the page prints at
 * ~192 dpi — crisp for text at reading distance. The three values are the
 * pixel spec itself: `design/export-rediseno/Main.dc.html`, composed at
 * this exact size with this exact margin. There is no `FOOT_H` any more —
 * the footer is now a block with its own rule, like every other block in
 * the flow, and it measures itself instead of being carved out in advance.
 */
const PAGE_W = 794;
const PAGE_H = 1123;
const MARGIN = 104;

/**
 * Every colour fixed in hex: the file is paper, whatever theme the app is in
 * when it is made. The two marks are two different mechanisms, not two
 * colours: the reader's highlight is a background wash and the AI's drops
 * the background and keeps only a dotted underline. They still read apart
 * photocopied in grey, and a saturated block of yellow stops reading like a
 * highlighter pass the moment it is not the only mark on the page.
 *
 * No `hyphens: auto`, and that is a rasterizer finding, not a taste: the
 * capture re-lays the text and draws an auto-hyphenated break WITHOUT the
 * hyphen glyph, so "justificado" came out of the PDF as "justific ado".
 * Justified-unhyphenated is looser; it is also correct.
 *
 * A trap not to step back into: the reader's mark is `background`, not
 * `box-shadow`. `box-shadow` is on html2canvas's list of properties it does
 * not paint, so a mark built that way would rasterize invisible, with no
 * error at all — the reader's highlight would simply be missing from the
 * PDF. `background` and `border-bottom`, what `.pdfx-mark` and
 * `.pdfx-mark--ai` actually use, do paint, which is why this already works
 * today. Anyone who wants the underline instead of the wash has to verify
 * it against `html2canvas-pro` first — it cannot be assumed.
 *
 * `.katex .tag`: KaTeX numbers a real `\begin{equation}`/`align`/`eqnarray`
 * it is asked to render on its own, with its OWN counter — a page-wide CSS
 * counter reset on `body` (`katexEqnNo`), painted by a `::before` on
 * `.eqn-num` — entirely independent of `numberedEquation`'s counter below.
 * Rendered live and looked at: a model's own `\begin{equation}` chunk
 * (`item.value === item.raw`, the other branch of `emitMath`,
 * latexExport.js) came out with TWO numbers side by side — KaTeX's own
 * "(1)", restarting from its first tagged environment on the page, and this
 * file's correct, document-order "(3)" a few pixels to its left. `$$…$$`
 * and `\[…\]` are silent on this: their bare interior carries no
 * environment for KaTeX to tag, only the model's own environments do.
 * `.pdfx-eq-n` is the one count that agrees with the .tex (LaTeX's own,
 * real numbering there), so KaTeX's own tag is hidden outright, wherever it
 * appears — not worth reproducing whatever numbering KaTeX chose, when the
 * document's real numbering has to come from `emitMath`'s decisions either
 * way, to agree with the .tex.
 *
 * This also swallows a hand-written `\tag{5}` inside a model's own
 * environment — KaTeX renders that as a `.katex .tag` too, and this rule
 * hides it the same as an automatic one. Now that the preamble loads
 * `amsmath` (`\tag` is one of its macros), that is a real asymmetry rather
 * than a moot one: the .tex used to fail outright on `\tag` with no
 * document to disagree with, and now compiles it, printing exactly "(5)",
 * while the PDF still shows `emitMath`'s own document-order number instead.
 * Left as is — reproducing an author-chosen tag here would mean threading
 * its value out of `emitMath`'s decisions and into this renderer, which is
 * a feature, not the numbering-agreement bug this file already fixes.
 */
const PAGE_CSS = `
.pdfx-page { box-sizing: border-box; width: ${PAGE_W}px; height: ${PAGE_H}px; padding: 62px ${MARGIN}px 46px; display: flex; flex-direction: column; background: #ffffff; color: #111318; font-family: 'Newsreader Variable', 'Iowan Old Style', Georgia, serif; }
.pdfx-page * { box-sizing: border-box; margin: 0; }
.pdfx-mast { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 500; line-height: 1; letter-spacing: 0.12em; text-transform: uppercase; color: #7b8290; }
.pdfx-mast-b { color: #111318; }
.pdfx-mast-rule { height: 1.3px; background: #111318; margin-top: 8px; }
.pdfx-mast-rule--cont { height: 0.8px; background: #c9ccd4; margin-top: 9px; }
.pdfx-hair { height: 0.8px; background: #dcdee4; }
.pdfx-title { font-size: 30px; font-weight: 400; line-height: 1.14; letter-spacing: -0.006em; margin-top: 23px; text-wrap: pretty; }
.pdfx-byline { font-size: 16px; line-height: 1.35; margin-top: 12px; }
.pdfx-source { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 10px; line-height: 1.5; letter-spacing: 0.035em; color: #7b8290; margin: 6px 0 17px; }
.pdfx-notice { display: flex; gap: 22px; padding: 11px 0 12px; }
.pdfx-notice-l { flex: 0 0 58px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 500; line-height: 1.85; letter-spacing: 0.12em; text-transform: uppercase; color: #7b8290; }
.pdfx-notice-t { flex: 1 1 auto; font-size: 13.5px; line-height: 1.52; color: #3a3e46; text-align: justify; }
.pdfx-flow { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.pdfx-flow--cont { padding-top: 24px; }
.pdfx-sec { display: flex; gap: 13px; margin: 21px 0 9px; }
.pdfx-sec--first { margin-top: 12px; }
.pdfx-sec-no { flex: 0 0 22px; font-size: 17px; font-weight: 600; line-height: 1.3; }
.pdfx-sec-n { font-size: 17px; font-weight: 600; line-height: 1.3; }
.pdfx-sec-o { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9.5px; line-height: 1.5; letter-spacing: 0.03em; color: #6b7280; margin-top: 3px; }
.pdfx-para { font-size: 16px; line-height: 1.6; text-align: justify; }
.pdfx-para + .pdfx-para { text-indent: 1.4em; }
.pdfx-eq { display: flex; align-items: baseline; gap: 16px; margin: 15px 0 16px; }
.pdfx-eq-b { flex: 1 1 auto; text-align: center; }
.pdfx-eq-n { flex: 0 0 auto; font-size: 15px; }
.pdfx-page .katex .tag { display: none; }
.pdfx-mark { background: #ffe066; color: inherit; padding: 0 1px; }
.pdfx-mark--ai { background: none; border-bottom: 1.4px dotted #6b7280; }
.pdfx-fnref { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9.5px; font-weight: 500; vertical-align: super; line-height: 0; padding-left: 1.5px; }
.pdfx-colo { margin-top: 30px; border-top: 1.3px solid #111318; padding-top: 12px; }
.pdfx-colo-h { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 500; line-height: 1; letter-spacing: 0.12em; text-transform: uppercase; color: #7b8290; margin-bottom: 10px; }
.pdfx-colo-g { display: grid; grid-template-columns: 116px 1fr; gap: 6px 18px; }
.pdfx-colo-k { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 10px; line-height: 1.55; letter-spacing: 0.03em; color: #868d99; }
.pdfx-colo-v { font-size: 13.5px; line-height: 1.42; }
.pdfx-notes { flex: 0 0 auto; padding-top: 11px; }
.pdfx-notes::before { content: ''; display: block; width: 132px; height: 0.8px; background: #111318; margin-bottom: 9px; }
.pdfx-note { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.46; color: #3a3e46; margin-bottom: 5px; }
.pdfx-note-no { flex: 0 0 11px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9.5px; font-weight: 500; line-height: 1.95; color: #7b8290; }
.pdfx-note-kind { font-variant: small-caps; letter-spacing: 0.045em; color: #111318; }
.pdfx-foot { flex: 0 0 auto; padding-top: 12px; }
.pdfx-foot-row { display: flex; align-items: baseline; gap: 14px; padding-top: 7px; }
.pdfx-foot-s { flex: 1 1 auto; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; line-height: 1.5; letter-spacing: 0.03em; color: #868d99; }
.pdfx-foot-n { font-size: 13px; }
.pdfx-page .katex { font-size: 1.02em; }
`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderMath(katex, item) {
  if (!katex) return null;
  try {
    return katex.renderToString(item.value, {
      displayMode: item.display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
    });
  } catch {
    return null;
  }
}

/**
 * The numbered row `Main2.dc.html` shows for a display formula — centred,
 * its number to the right (`.pdfx-eq`/`.pdfx-eq-b`/`.pdfx-eq-n`, PAGE_CSS).
 *
 * `counter` is one `{ n }` object created once in `buildBlocks` and passed
 * into every `renderParagraphInto` call from there, so numbering carries on
 * across paragraphs and sections instead of restarting at zero each time
 * this function runs.
 *
 * Gated by the caller on `isNumberedFormula` (latexExport.js) — shared with
 * `emitMath`'s decision to wrap a formula in `\begin{equation}` for the .tex,
 * so an unsafe or a marked formula can never claim a number here that the
 * .tex does not also give it.
 *
 * `rows` answers a question `isNumberedFormula` does not: not "does this
 * formula get a number" but "how many". A model-authored `\begin{align}`
 * reaches the .tex as one chunk (`emitMath` does not re-wrap an environment
 * the model already wrote) but LaTeX numbers each ROW of it — `\notag`
 * aside — so counting chunks the way this function used to (always `+= 1`)
 * let every formula AFTER one drift out of sync with the .tex, one number
 * short per extra row. Reimplementing that counting means parsing `\notag`,
 * `\nonumber` and `\\[2pt]` — but KaTeX has already made the same decision by
 * the time this runs: rendered live and inspected, it paints one `.eqn-num`
 * per row it numbers — none for a `\notag` row, confirmed with a three-row
 * `align` and the middle row marked `\notag`, which produced exactly two —
 * so counting those uses the renderer as the oracle rather than re-deriving
 * LaTeX's own rule. `.eqn-num` is nested inside the single `.katex .tag`
 * wrapper PAGE_CSS already hides above, whatever the row count, so hiding it
 * still hides every row's number with no change needed there. The badge
 * still shows one number — this row's first, matching the row the .tex
 * numbers first — and the extra rows are folded into the running count so
 * whatever comes next still gets the number the .tex will also give it.
 *
 * `\begin{eqnarray}` — base LaTeX, needs no `amsmath` — takes a different
 * path entirely: KaTeX does not implement that environment at all ("No such
 * environment: eqnarray", confirmed live), so `renderMath` below catches the
 * error and falls back to the chunk's own raw source as plain text — visibly
 * broken on the page, not merely mis-numbered, while the .tex renders it
 * correctly. `rows` still falls back to 1 for it (no `.eqn-num` exists to
 * count on unrendered text), which does not fix that page — a pre-existing
 * gap this fix neither causes nor closes — but does mean this function's own
 * behaviour for it is unchanged, not made worse.
 */
function numberedEquation(piece, counter) {
  const rows = piece.querySelectorAll('.katex .eqn-num').length || 1;
  counter.n += 1;
  const label = counter.n;
  if (rows > 1) counter.n += rows - 1;
  const body = element('div', 'pdfx-eq-b');
  body.appendChild(piece);
  const row = element('div', 'pdfx-eq');
  row.append(body, element('span', 'pdfx-eq-n', `(${label})`));
  return row;
}

/**
 * One paragraph, marks and note markers in place. Runs of the same highlight
 * are kept as separate <mark>s (the seams do not show in HTML the way they do
 * in LaTeX), but the footnote marker goes after the LAST piece of its run, so
 * a highlight that crosses a formula reads as one mark with one number.
 */
function renderParagraphInto(node, text, annotations, katex, eqCounter) {
  const plan = buildHighlightPlan(text, annotations);
  const noted = new Map(annotations
    .filter(item => item.note && item.number != null)
    .map(item => [item.id, item.number]));

  plan.forEach((item, index) => {
    const marked = item.type === 'mark' || (item.type === 'math' && item.kind);
    let piece;
    if (item.type === 'math') {
      const html = renderMath(katex, item);
      piece = element(marked ? 'mark' : 'span', marked ? markClass(item.kind) : undefined);
      if (html === null) piece.textContent = item.raw;
      else piece.innerHTML = html;
      if (eqCounter && isNumberedFormula(item)) piece = numberedEquation(piece, eqCounter);
    } else if (item.type === 'mark') {
      piece = element('mark', markClass(item.kind), displayProse(item.value));
    } else {
      piece = document.createTextNode(displayProse(item.value));
    }
    node.appendChild(piece);

    if (marked && noted.has(item.id)) {
      const next = plan[index + 1];
      const runEnds = !next || next.id !== item.id
        || !(next.type === 'mark' || (next.type === 'math' && next.kind));
      if (runEnds) {
        node.appendChild(element('sup', 'pdfx-fnref', String(noted.get(item.id))));
      }
    }
  });
}

function markClass(kind) {
  return kind === 'ai' ? 'pdfx-mark pdfx-mark--ai' : 'pdfx-mark';
}

/** The blocks the pages are filled with, each with the notes it must seat. */
function buildBlocks(model, katex) {
  const blocks = [];
  const push = (node, { notes = [], heading = null } = {}) => {
    blocks.push({ node, notes, heading });
  };
  // Lives here, not inside `renderParagraphInto`: created once per document
  // and threaded through every call below, so the count keeps climbing
  // across paragraphs and sections instead of resetting at the top of each
  // paragraph.
  const eqCounter = { n: 0 };

  const title = element('h1', 'pdfx-title');
  renderParagraphInto(title, model.meta.title, [], katex, eqCounter);
  push(title);
  if (model.meta.byline) push(element('div', 'pdfx-byline', model.meta.byline));
  if (model.meta.source) push(element('div', 'pdfx-source', model.meta.source));

  push(element('div', 'pdfx-hair'));
  const notice = element('div', 'pdfx-notice');
  notice.append(
    element('span', 'pdfx-notice-l', model.meta.noticeLabel),
    element('p', 'pdfx-notice-t', model.meta.notice),
  );
  push(notice);
  push(element('div', 'pdfx-hair'));

  model.sections.forEach((section, index) => {
    // The reduced top margin belongs to the first section OF THE DOCUMENT,
    // not to whichever block a page break happens to open with — `:first-child`
    // would fire on any continuation page whose overflowed block happened to
    // be a heading, which is not what this spacing means. `pdfx-sec--first`
    // is set once, here, by document position, and PAGE_CSS keys off it
    // instead of the page-relative selector.
    const head = element('div', index === 0 ? 'pdfx-sec pdfx-sec--first' : 'pdfx-sec');
    const stack = element('div');
    stack.appendChild(element('h2', 'pdfx-sec-n', section.label));
    // El encabezado tal como está impreso en el paper, igual que en el lector.
    if (section.originalHeading) {
      stack.appendChild(element('p', 'pdfx-sec-o', section.originalHeading));
    }
    head.append(element('span', 'pdfx-sec-no', String(index + 1)), stack);
    // `heading` deja de ser un booleano: lleva el texto del titulillo, que el
    // paginador necesita para saber en qué sección acaba cada página.
    // `runningLabel` (buildPdfModel, arriba) ya llega acotado a 30
    // caracteres por `sectionMarkText` — el mismo tope que el `.tex` aplica
    // al argumento corto de `\section`, para la misma colisión con
    // `meta.runningTitle` a su izquierda en esta cabecera. `section.label`,
    // sin acotar, es el que va al `<h2>` de la página: ese no cambia.
    push(head, { heading: `${index + 1}\u2002\u00b7\u2002${section.runningLabel}` });

    for (const paragraph of section.paragraphs) {
      const node = element('p', 'pdfx-para');
      node.lang = model.language;
      renderParagraphInto(node, paragraph.text, paragraph.annotations, katex, eqCounter);
      const notes = paragraph.annotations
        .filter(item => item.note && item.number != null)
        .map(item => ({
          number: item.number,
          kind: item.kind === 'ai' ? model.labels.ai : model.labels.mine,
          text: item.note,
        }));
      push(node, { notes });
    }
  });

  if (model.meta.colophon.rows.length > 0) {
    const colo = element('div', 'pdfx-colo');
    colo.appendChild(element('p', 'pdfx-colo-h', model.meta.colophon.heading));
    const grid = element('div', 'pdfx-colo-g');
    for (const row of model.meta.colophon.rows) {
      grid.append(element('span', 'pdfx-colo-k', row.key), element('p', 'pdfx-colo-v', row.value));
    }
    colo.appendChild(grid);
    push(colo);
  }

  return blocks;
}

function noteEntry(note) {
  const node = element('div', 'pdfx-note');
  const body = element('span');
  body.append(
    element('span', 'pdfx-note-kind', note.kind),
    document.createTextNode(`\u2002${note.text}`),
  );
  node.append(element('span', 'pdfx-note-no', String(note.number)), body);
  return node;
}

/**
 * Lays the model out as A4 page divs inside `host` and returns them.
 *
 * Blocks are seated one at a time and the page is asked, by measuring, whether
 * they fit; notes travel with the paragraph that carries their marker, so a
 * note sits at the foot of the page its passage landed on — the .tex gets this
 * from LaTeX, here it has to be earned. A block that overflows an otherwise
 * empty page stays and is clipped: a single paragraph taller than A4 is not a
 * case worth a column model. A heading is never left as the last thing on a
 * page — if its first paragraph moves on, it moves with it.
 *
 * Each page also gets its furniture: an identity masthead on page 1, a
 * running head naming the current section on every page after it, and a
 * footer with the provenance line and the page number. The running head
 * cannot be written when the page is made — see the comment further down,
 * where it is actually filled in, for why that has to wait.
 */
export async function renderPdfPages(model, host) {
  const katex = await loadKatex();
  if (!host.querySelector('style[data-pdfx]')) {
    const style = element('style');
    style.dataset.pdfx = '';
    style.textContent = PAGE_CSS;
    host.appendChild(style);
  }

  const pages = [];
  const heads = [];
  const marks = [];
  let page = null;
  let flow = null;
  let notes = null;

  const newPage = () => {
    page = element('div', 'pdfx-page');
    const mast = element('div', 'pdfx-mast');
    const mastL = element('span');
    const mastR = element('span');
    mast.append(mastL, mastR);
    const mastRule = element('div');
    // La primera página se presenta; las demás navegan.
    if (pages.length === 0) {
      mastL.appendChild(element('span', 'pdfx-mast-b', model.meta.masthead));
      mastR.textContent = model.meta.level;
      mastRule.className = 'pdfx-mast-rule';
    } else {
      mastL.appendChild(element('span', 'pdfx-mast-b', model.meta.runningTitle));
      mastRule.className = 'pdfx-mast-rule--cont';
    }
    heads.push(mastR);

    flow = element('div', pages.length === 0 ? 'pdfx-flow' : 'pdfx-flow pdfx-flow--cont');
    notes = element('div', 'pdfx-notes');
    notes.style.display = 'none';

    const foot = element('div', 'pdfx-foot');
    foot.appendChild(element('div', 'pdfx-hair'));
    const row = element('div', 'pdfx-foot-row');
    row.append(
      element('span', 'pdfx-foot-s', model.meta.provenance),
      element('span', 'pdfx-foot-n', String(pages.length + 1)),
    );
    foot.appendChild(row);

    page.append(mast, mastRule, flow, notes, foot);
    host.appendChild(page);
    pages.push(page);
  };

  const overflows = () => flow.scrollHeight > flow.clientHeight + 1;

  newPage();
  for (const block of buildBlocks(model, katex)) {
    flow.appendChild(block.node);
    const seated = block.notes.map(noteEntry);
    if (seated.length > 0) {
      notes.style.display = '';
      for (const entry of seated) notes.appendChild(entry);
    }
    if (overflows() && flow.children.length > 1) {
      block.node.remove();
      for (const entry of seated) entry.remove();
      if (!notes.children.length) notes.style.display = 'none';
      // An orphaned heading follows its paragraph to the next page.
      const last = flow.lastElementChild;
      const carried = last?.classList.contains('pdfx-sec') && flow.children.length > 1
        ? last
        : null;
      newPage();
      if (carried) {
        flow.appendChild(carried);
        // A carried heading already has a mark, recorded below when IT was
        // seated — for the page it is now leaving. Moving the node without
        // moving its mark would leave that abandoned page's running head
        // claiming a section it no longer shows a word of, so the mark
        // follows the node to the page it actually ends up on.
        const movedMark = marks.find(mark => mark.node === carried);
        if (movedMark) movedMark.page = pages.length - 1;
      }
      flow.appendChild(block.node);
      if (seated.length > 0) {
        notes.style.display = '';
        for (const entry of seated) notes.appendChild(entry);
      }
    }
    // The block may have just moved to a new page above, so which page it
    // ends up on is only known now, at the end of the loop body — reading
    // `pages.length - 1` any earlier would attribute it to the page it left.
    if (block.heading) marks.push({ page: pages.length - 1, text: block.heading, node: block.node });
  }

  // El titulillo dice en qué sección vas. Se escribe ahora y no al crear la
  // página porque una página se crea vacía: hasta que no se ha sentado todo no
  // se sabe qué secciones cayeron en ella. Una página sin título propio hereda
  // el de la anterior, que es justo el caso de una sección que continúa.
  let running = '';
  for (let index = 0; index < pages.length; index += 1) {
    const own = marks.filter(mark => mark.page === index).at(-1);
    if (own) running = own.text;
    if (index > 0) heads[index].textContent = running;
  }

  // Fonts settle after the text is in the DOM; the capture must not race them.
  if (document.fonts?.ready) await document.fonts.ready;
  return pages;
}

/**
 * Rasterizes the pages and hands the file over.
 *
 * Both libraries arrive as their own chunks, on demand, the way KaTeX does:
 * nobody pays for the exporter before asking for a PDF. Returns the blob and
 * the page count so the live harness can check the output without touching
 * the reader's downloads folder (`deliver: false`).
 */
export async function downloadPdfDocument(model, { deliver = true } = {}) {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas-pro'),
  ]);

  const host = element('div');
  host.style.cssText = 'position: absolute; top: 0; left: -10000px; width: '
    + `${PAGE_W}px; background: #ffffff;`;
  document.body.appendChild(host);

  try {
    const pages = await renderPdfPages(model, host);
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const [docW, docH] = [doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight()];

    for (let index = 0; index < pages.length; index += 1) {
      const canvas = await html2canvas(pages[index], {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
      });
      if (index > 0) doc.addPage();
      doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, docW, docH);
    }

    if (deliver) doc.save(model.fileName);
    return { blob: doc.output('blob'), pageCount: pages.length };
  } finally {
    host.remove();
  }
}
