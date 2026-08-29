import {
  documentCopy,
  exportFileName,
  exportableAnnotations,
  numberAnnotations,
} from './latexExport.js';
import { displayProse } from './latex.js';
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
 * reader's the way the export card's preview promises — grey with an ink
 * underline versus the brand yellow.
 *
 * The model half of this file is pure and tested under node; everything from
 * `renderPdfPages` down needs a DOM and is verified live.
 */

const SECTION_FALLBACK = { es: 'Sección', en: 'Section' };

/** The byline as plain words: up to `limit` names, then honesty. */
export function plainAuthorLine(paper, limit = 12) {
  const authors = Array.isArray(paper?.authors) ? paper.authors : [];
  const names = authors
    .map(author => String(author?.name || author || '').trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  const shown = names.slice(0, limit);
  return names.length > limit ? `${shown.join(', ')} et al.` : shown.join(', ');
}

/**
 * Everything the pages need, decided before any DOM exists. The include
 * switches and the numbering follow `buildLatexDocument` exactly: an export
 * that filtered differently by format would put different notes in the two
 * files a reader believes are the same document.
 *
 * @returns {{
 *   title: string, byline: string, stamp: string, abstract: string,
 *   provenance: string, originalUrl: string, language: string,
 *   labels: { mine: string, ai: string },
 *   sections: Array<{ label: string, paragraphs: Array<{ text: string, annotations: Array<object> }> }>,
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
  include = {},
} = {}) {
  const copy = documentCopy(language);
  const wantMarks = include.marks !== false;
  const wantMine = include.mine !== false;
  const wantAi = include.ai !== false;

  const kept = exportableAnnotations(annotations, { sections, level, language })
    .filter(item => {
      if (item.kind === 'ai') return wantAi;
      return item.note ? wantMine : wantMarks;
    });

  const { byParagraph, numbered } = numberAnnotations(sections, kept);
  const fallback = SECTION_FALLBACK[language === 'en' ? 'en' : 'es'];

  return {
    title: String(paper?.title || ''),
    byline: plainAuthorLine(paper),
    stamp: copy.stamp(copy.levels[level] || level),
    abstract: copy.abstract,
    provenance: copy.provenance,
    originalUrl: String(originalUrl || ''),
    language: language === 'en' ? 'en' : 'es',
    labels: { mine: copy.mine, ai: copy.ai },
    sections: sections.map(section => ({
      label: section?.heading || kindLabels[section?.kind] || fallback,
      paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
        .map((text, index) => ({
          text,
          annotations: byParagraph.get(`${section?.id}:${index}`) || [],
        })),
    })),
    noteCount: numbered.length,
    fileName: exportFileName(paper, language, 'pdf'),
  };
}

/* ── From here on, browser only ─────────────────────────────────────────── */

/**
 * A4 at 96 dpi. The rasterizer captures at scale 2, so the page prints at
 * ~192 dpi — crisp for text at reading distance. Margins are the .tex's own
 * geometry (28 mm, 34 mm at the foot) rounded to the pixel.
 */
const PAGE_W = 794;
const PAGE_H = 1123;
const MARGIN = 106;
const FOOT_H = 129;

/**
 * Every colour fixed in hex: the file is paper, whatever theme the app is in
 * when it is made. The marks are the export card's preview kept: brand yellow
 * for the reader's, grey with an ink underline for the AI's.
 *
 * No `hyphens: auto`, and that is a rasterizer finding, not a taste: the
 * capture re-lays the text and draws an auto-hyphenated break WITHOUT the
 * hyphen glyph, so "justificado" came out of the PDF as "justific ado".
 * Justified-unhyphenated is looser; it is also correct.
 */
const PAGE_CSS = `
.pdfx-page { box-sizing: border-box; width: ${PAGE_W}px; height: ${PAGE_H}px; padding: ${MARGIN}px ${MARGIN}px 0; display: flex; flex-direction: column; background: #ffffff; color: #111318; font-family: 'Newsreader Variable', 'Iowan Old Style', Georgia, serif; font-size: 15px; line-height: 1.55; }
.pdfx-page * { box-sizing: border-box; margin: 0; }
.pdfx-flow { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.pdfx-title { font-size: 27px; line-height: 1.22; font-weight: 600; text-align: center; margin-bottom: 18px; }
.pdfx-byline { text-align: center; font-size: 14px; margin: 0 32px 10px; }
.pdfx-stamp { text-align: center; font-size: 13px; color: #4a4d55; margin-bottom: 26px; }
.pdfx-abstract { margin: 0 44px 26px; font-size: 13.5px; line-height: 1.5; text-align: justify; color: #33363d; }
.pdfx-heading { font-size: 18px; font-weight: 600; margin: 22px 0 10px; }
.pdfx-para { text-align: justify; margin-bottom: 12px; }
.pdfx-mark { background: #ffd21e; color: inherit; padding: 1px 0; }
.pdfx-mark--ai { background: #f0f0f1; border-bottom: 2px solid #111318; }
.pdfx-fnref { font-size: 10px; vertical-align: super; line-height: 0; font-weight: 600; }
.pdfx-notes { flex: 0 0 auto; padding: 8px 0 10px; }
.pdfx-notes::before { content: ''; display: block; width: 150px; height: 1px; background: #111318; margin-bottom: 8px; }
.pdfx-note { font-size: 11.5px; line-height: 1.45; color: #33363d; margin-bottom: 4px; }
.pdfx-note-kind { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #4a4d55; margin-right: 7px; }
.pdfx-foot { flex: 0 0 auto; height: ${FOOT_H}px; display: flex; align-items: center; gap: 12px; padding-top: 6px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 10px; color: #4a4d55; }
.pdfx-foot-link { color: #4a4d55; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdfx-foot-page { margin-left: auto; color: #111318; }
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
 * One paragraph, marks and note markers in place. Runs of the same highlight
 * are kept as separate <mark>s (the seams do not show in HTML the way they do
 * in LaTeX), but the footnote marker goes after the LAST piece of its run, so
 * a highlight that crosses a formula reads as one mark with one number.
 */
function renderParagraphInto(node, text, annotations, katex) {
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
  const push = (node, { notes = [], heading = false } = {}) => {
    blocks.push({ node, notes, heading });
  };

  const title = element('h1', 'pdfx-title');
  renderParagraphInto(title, model.title, [], katex);
  push(title);
  if (model.byline) push(element('div', 'pdfx-byline', model.byline));
  push(element('div', 'pdfx-stamp', model.stamp));
  push(element('div', 'pdfx-abstract', model.abstract));

  model.sections.forEach((section, index) => {
    push(element('h2', 'pdfx-heading', `${index + 1}\u2002${section.label}`), { heading: true });
    for (const paragraph of section.paragraphs) {
      const node = element('p', 'pdfx-para');
      node.lang = model.language;
      renderParagraphInto(node, paragraph.text, paragraph.annotations, katex);
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

  return blocks;
}

function noteEntry(note) {
  const node = element('div', 'pdfx-note');
  node.appendChild(element('sup', 'pdfx-fnref', String(note.number)));
  node.appendChild(document.createTextNode(' '));
  node.appendChild(element('span', 'pdfx-note-kind', note.kind));
  node.appendChild(document.createTextNode(note.text));
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
  let page = null;
  let flow = null;
  let notes = null;

  const newPage = () => {
    page = element('div', 'pdfx-page');
    flow = element('div', 'pdfx-flow');
    notes = element('div', 'pdfx-notes');
    notes.style.display = 'none';
    const foot = element('div', 'pdfx-foot');
    foot.appendChild(element('span', undefined, model.provenance));
    if (model.originalUrl) {
      foot.appendChild(element('span', undefined, '·'));
      foot.appendChild(element('span', 'pdfx-foot-link', model.originalUrl));
    }
    foot.appendChild(element('span', 'pdfx-foot-page', String(pages.length + 1)));
    page.append(flow, notes, foot);
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
      const carried = last?.classList.contains('pdfx-heading') && flow.children.length > 1
        ? last
        : null;
      newPage();
      if (carried) flow.appendChild(carried);
      flow.appendChild(block.node);
      if (seated.length > 0) {
        notes.style.display = '';
        for (const entry of seated) notes.appendChild(entry);
      }
    }
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
