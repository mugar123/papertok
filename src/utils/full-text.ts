/**
 * One document model for a paper's full text, read from the two shapes
 * providers publish it in: arXiv's LaTeXML HTML and Europe PMC's JATS XML.
 * The Worker fetches the source document (worker/full-text.ts); this parses
 * it in the browser, which has a DOM.
 *
 * Nothing from the source is rendered as markup except MathML, rebuilt here
 * from an allowlist of MathML elements and attributes.
 */
import { safeCatalogUrl, safeExternalUrl } from './external-url.ts';

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'em' | 'strong' | 'sup' | 'sub' | 'code'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'ref'; target: string; children: Inline[] }
  | { t: 'math'; mathml: string; tex?: string }
  | { t: 'formula-image'; src: string };

export type FigureImage = { src: string; alt?: string };

export type Cell = { header: boolean; colSpan: number; rowSpan: number; content: Inline[] };

/** A display formula: its TeX when the source kept it, its MathML, or only a picture of it. */
export type Formula = { mathml?: string; tex?: string; image?: string };

export type Block =
  | { t: 'heading'; level: number; id?: string; label?: string; children: Inline[] }
  | { t: 'p'; children: Inline[] }
  | ({ t: 'equation'; id?: string; label?: string } & Formula)
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'figure'; id?: string; label?: string; images: FigureImage[]; caption: Inline[] }
  | { t: 'table'; id?: string; label?: string; caption: Inline[]; rows: Cell[][] };

/**
 * A cited work, read into fields where the source structures it (JATS
 * citations, LaTeXML's author/title/venue blocks). `text` holds the whole
 * citation as one line when it does not, and is empty when the fields do.
 */
export type Reference = {
  id: string;
  label: string;
  authors: string[];
  year?: string;
  title?: string;
  venue?: string;
  doi?: string;
  pmid?: string;
  arxiv?: string;
  url?: string;
  text: string;
};

export type Note = { id: string; label: string; content: Inline[] };

export type FullText = {
  source: 'arxiv' | 'ar5iv' | 'europepmc';
  sourceUrl: string;
  license?: string;
  lang?: string;
  abstract: Block[];
  body: Block[];
  references: Reference[];
  notes: Note[];
  conversionErrors: number;
};

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const MATHML_ELEMENTS = new Set([
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'mfrac', 'msqrt', 'mroot',
  'mstyle', 'merror', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msub', 'msup', 'msubsup', 'munder', 'mover',
  'munderover', 'mmultiscripts', 'mprescripts', 'none', 'mtable', 'mtr', 'mtd', 'mlabeledtr',
]);
const MATHML_ATTRIBUTES = new Set([
  'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'lspace', 'rspace', 'form',
  'columnalign', 'rowalign', 'columnspan', 'rowspan', 'linethickness', 'movablelimits', 'largeop', 'symmetric',
  'minsize', 'maxsize', 'scriptlevel', 'displaystyle', 'encoding', 'notation', 'open', 'close', 'separators', 'alttext',
  'width', 'height', 'depth', 'voffset',
]);

const mo = (text: string) => {
  const out = document.createElementNS(MATHML_NS, 'mo');
  out.textContent = text;
  return out;
};

// Browsers dropped `mfenced` with MathML Core, so a JATS formula that uses it
// lost its brackets. It becomes the row of operators it stands for.
function unfence(source: Element): Element {
  const out = document.createElementNS(MATHML_NS, 'mrow');
  const separators = (source.getAttribute('separators') ?? ',').replace(/\s/g, '');
  const parts = [...source.children].map(cleanMath).filter((part): part is Element => Boolean(part));
  out.append(mo(source.getAttribute('open') ?? '('));
  parts.forEach((part, index) => {
    if (index > 0 && separators) out.append(mo(separators[Math.min(index - 1, separators.length - 1)]));
    out.append(part);
  });
  out.append(mo(source.getAttribute('close') ?? ')'));
  return out;
}

function cleanMath(source: Element): Element | null {
  const name = source.localName;
  if (!MATHML_ELEMENTS.has(name)) return null;
  if (name === 'mfenced') return unfence(source);
  const out = document.createElementNS(MATHML_NS, name);
  for (const attr of source.attributes) {
    if (MATHML_ATTRIBUTES.has(attr.localName)) out.setAttribute(attr.localName, attr.value);
  }
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out.append(child.textContent ?? '');
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const clean = cleanMath(child as Element);
      if (clean) out.append(clean);
    }
  }
  return out;
}

const mathml = (el: Element) => cleanMath(el)?.outerHTML ?? '';

const INLINE_TAGS: Record<string, 'em' | 'strong' | 'sup' | 'sub' | 'code'> = {
  em: 'em', i: 'em', italic: 'em',
  strong: 'strong', b: 'strong', bold: 'strong',
  sup: 'sup', sub: 'sub',
  code: 'code', tt: 'code', monospace: 'code',
};

const hasClass = (el: Element, name: string) => el.classList?.contains(name) ?? false;

type InlineRules = {
  skip: (el: Element) => boolean;
  ref: (el: Element) => string | null;
  link: (el: Element) => string | null;
  /** The TeX a source kept beside a formula's MathML. */
  tex: (math: Element) => string | undefined;
  /** An element a source renders as something of its own: a footnote mark, a pictured formula. */
  replace?: (el: Element) => Inline | null;
};

function inlines(node: Node, rules: InlineRules): Inline[] {
  const out: Inline[] = [];
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (text) out.push({ t: 'text', text });
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.localName === 'math') {
      out.push({ t: 'math', mathml: mathml(el), tex: rules.tex(el) });
      continue;
    }
    const replacement = rules.replace?.(el);
    if (replacement) {
      out.push(replacement);
      continue;
    }
    if (rules.skip(el)) continue;
    const target = rules.ref(el);
    if (target) {
      out.push({ t: 'ref', target, children: inlines(el, rules) });
      continue;
    }
    const href = rules.link(el);
    if (href) {
      out.push({ t: 'link', href, children: inlines(el, rules) });
      continue;
    }
    const tag = INLINE_TAGS[el.localName];
    if (tag) out.push({ t: tag, children: inlines(el, rules) });
    else out.push(...inlines(el, rules));
  }
  return out;
}

export const plainText = (content: Inline[]): string =>
  content.map(item => (item.t === 'text' ? item.text : 'children' in item ? plainText(item.children) : '')).join('');

const hasMath = (content: Inline[]) => content.some(item => item.t === 'math' || item.t === 'formula-image');

const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();

const absoluteUrl = (value: string | null, base: string) => {
  if (!value) return null;
  try {
    return safeCatalogUrl(new URL(value, base).toString()) || null;
  } catch {
    return null;
  }
};

const rows = (table: Element, rules: InlineRules): Cell[][] =>
  [...table.querySelectorAll('tr')].map(tr =>
    [...tr.children]
      .filter(cell => cell.localName === 'td' || cell.localName === 'th')
      .map(cell => ({
        header: cell.localName === 'th' || hasClass(cell, 'ltx_th') || cell.closest('thead') !== null,
        colSpan: Number(cell.getAttribute('colspan')) || 1,
        rowSpan: Number(cell.getAttribute('rowspan')) || 1,
        content: inlines(cell, rules),
      })));

// arXiv: LaTeXML's ltx_* classes.

/**
 * The year, DOI and arXiv id a citation line names. The year is the last
 * 1800–2099 number that does not head a decimal, so "arXiv:1810.04805" is not
 * the year 1810.
 */
export function citationFacts(line: string) {
  return {
    year: line.match(/\b(1[89]|20)\d{2}\b(?!\.\d)/g)?.at(-1),
    doi: line.match(/\b10\.\d{4,9}\/\S*[^\s.,;)]/)?.[0],
    arxiv: line.match(/arXiv:\s?(\d{4}\.\d{4,5})/i)?.[1] ?? line.match(/abs\/(\d{4}\.\d{4,5})/)?.[1],
  };
}

/**
 * LaTeXML's TeX in the dialect KaTeX reads. KaTeX rejected 124 of the 1,400
 * formulas of math/0211159 and 20 of 122 of 1512.03385 on these three.
 */
export function latexmlTex(alttext: string | null | undefined) {
  return clean(alttext)
    .replace(/\\begin\{array\}\[[^\]]*\]/g, '\\begin{array}')
    .replace(/\\mbox(?![a-zA-Z])/g, '\\text')
    .replace(/\\lx@sectionsign/g, '\\S') || undefined;
}

// LaTeXML splits a bibliography entry into blocks: authors, title, then
// venue and year. An entry with fewer blocks was not split, and stays text.
function latexmlReference(item: Element, index: number): Reference {
  const blocks = [...item.querySelectorAll('.ltx_bibblock')].map(block => clean(block.textContent));
  const all = blocks.join(' ');
  const facts = citationFacts(all);
  const split = blocks.length >= 3;
  const [authorLine = '', title = '', ...rest] = blocks;
  const link = [...item.querySelectorAll('a[href]')].map(a => safeCatalogUrl(a.getAttribute('href'))).find(Boolean);
  return {
    id: item.id,
    label: clean(item.querySelector('.ltx_tag_bibitem')?.textContent).replace(/^\[|\]$/g, '') || String(index + 1),
    authors: split ? authorLine.replace(/\.$/, '').split(/,\s*(?:and\s+)?|\s+and\s+/).map(clean).filter(Boolean) : [],
    year: facts.year,
    title: split ? title.replace(/\.$/, '') : undefined,
    venue: split ? rest.join(' ').replace(/,?\s*(1[89]|20)\d{2}[a-z]?\.?\s*$/, '').replace(/\.$/, '') || undefined : undefined,
    doi: facts.doi,
    arxiv: facts.arxiv,
    url: link || undefined,
    text: split ? '' : all,
  };
}

export function parseArxivHtml(html: string, url: string): FullText | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const article = doc.querySelector('article.ltx_document');
  if (!article) return null;
  const notes: Note[] = [];
  const rules: InlineRules = {
    skip: el => hasClass(el, 'ltx_note_mark') || hasClass(el, 'ltx_note_outer') || el.localName === 'button',
    ref: el => {
      const href = el.localName === 'a' ? el.getAttribute('href') : null;
      return href?.startsWith('#') ? href.slice(1) : null;
    },
    link: el => (el.localName === 'a' ? absoluteUrl(el.getAttribute('href'), url) : null),
    tex: math => latexmlTex(math.getAttribute('alttext')),
    // A footnote is written where its mark is; it is read at the end.
    replace: el => {
      if (!hasClass(el, 'ltx_note') || !hasClass(el, 'ltx_role_footnote') || !el.id) return null;
      const label = clean(el.querySelector(':scope > .ltx_note_mark')?.textContent) || String(notes.length + 1);
      if (!notes.some(note => note.id === el.id)) {
        const content = el.querySelector('.ltx_note_content')?.cloneNode(true) as Element | undefined;
        content?.querySelectorAll('.ltx_note_mark, .ltx_note_type, .ltx_tag_note').forEach(part => part.remove());
        notes.push({ id: el.id, label, content: content ? inlines(content, rules) : [] });
      }
      return { t: 'sup', children: [{ t: 'ref', target: el.id, children: [{ t: 'text', text: label }] }] };
    },
  };
  const label = (el: Element | null) => el?.querySelector(':scope > .ltx_tag, .ltx_tag')?.textContent?.trim().replace(/[:.]$/, '') || undefined;
  const withoutTag = (el: Element) => {
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('.ltx_tag').forEach(tag => tag.remove());
    return clone;
  };

  const body: Block[] = [];
  const references: Reference[] = [];
  // A theorem's or a paragraph's run-in title ("Theorem 1.2.", "Proof.") opens
  // the paragraph that follows it, in bold, as the PDF prints it.
  let runIn: Inline[] | null = null;
  const walk = (el: Element) => {
    for (const child of el.children) {
      const name = child.localName;
      if (hasClass(child, 'ltx_abstract') || hasClass(child, 'ltx_authors') || hasClass(child, 'ltx_title_document')
        || hasClass(child, 'ltx_dates') || hasClass(child, 'ltx_classification') || hasClass(child, 'ltx_keywords')) continue;
      if (hasClass(child, 'ltx_bibliography')) {
        child.querySelectorAll('li.ltx_bibitem').forEach(item => references.push(latexmlReference(item, references.length)));
        continue;
      }
      if (/^h[1-6]$/.test(name) && hasClass(child, 'ltx_title') && hasClass(child, 'ltx_runin')) {
        runIn = inlines(child, rules);
        continue;
      }
      if (/^h[1-6]$/.test(name) && hasClass(child, 'ltx_title')) {
        const section = child.closest('section');
        body.push({ t: 'heading', level: Number(name[1]), id: section?.id || undefined, label: label(child), children: inlines(withoutTag(child), rules) });
        continue;
      }
      if (name === 'p' && hasClass(child, 'ltx_p')) {
        const content = inlines(child, rules);
        if (runIn) {
          content.unshift({ t: 'strong', children: runIn }, { t: 'text', text: ' ' });
          runIn = null;
        }
        if (plainText(content).trim() || hasMath(content)) body.push({ t: 'p', children: content });
        continue;
      }
      if (name === 'table' && (hasClass(child, 'ltx_equation') || hasClass(child, 'ltx_equationgroup'))) {
        // One display line per row: an aligned row puts each column in a cell
        // of its own (`x` | `= y + z`), and a row carries its own number.
        const seen = new Set<string>();
        const eqnRows = [...child.querySelectorAll('tr.ltx_eqn_row')];
        (eqnRows.length ? eqnRows : [child]).forEach(row => {
          const maths = [...row.querySelectorAll('math')];
          if (!maths.length) return;
          const owner = row.closest('tbody[id]')?.id || child.id;
          const id = owner && !seen.has(owner) ? owner : undefined;
          if (owner) seen.add(owner);
          const texs = maths.map(math => rules.tex(math));
          body.push({
            t: 'equation',
            id,
            label: clean(row.querySelector('.ltx_tag_equation')?.textContent) || undefined,
            mathml: maths.map(mathml).join(''),
            tex: texs.every(Boolean) ? texs.join(' ') : undefined,
          });
        });
        continue;
      }
      // A table given as a picture of itself falls through to the figure below.
      const table = name === 'figure' && hasClass(child, 'ltx_table') ? child.querySelector('table.ltx_tabular, table') : null;
      if (table) {
        const caption = child.querySelector('figcaption');
        body.push({ t: 'table', id: child.id || undefined, label: label(caption), caption: caption ? inlines(withoutTag(caption), rules) : [], rows: rows(table, rules) });
        continue;
      }
      if (name === 'figure') {
        const caption = child.querySelector(':scope > figcaption');
        const images = [...child.querySelectorAll('img')].flatMap(img => {
          // Only the renderer's own images: the reader promises figures from arXiv.
          const src = absoluteUrl(img.getAttribute('src'), url);
          if (src && new URL(src).origin !== new URL(url).origin) return [];
          const alt = img.getAttribute('alt')?.trim();
          return src ? [{ src, alt: alt && alt !== 'Refer to caption' ? alt : undefined }] : [];
        });
        if (images.length) body.push({ t: 'figure', id: child.id || undefined, label: label(caption), images, caption: caption ? inlines(withoutTag(caption), rules) : [] });
        else walk(child);
        continue;
      }
      if ((name === 'ul' || name === 'ol') && (hasClass(child, 'ltx_itemize') || hasClass(child, 'ltx_enumerate'))) {
        body.push({ t: 'list', ordered: name === 'ol', items: [...child.children].map(li => inlines(withoutTag(li), rules)) });
        continue;
      }
      walk(child);
    }
  };
  walk(article);

  const abstract = [...article.querySelectorAll('.ltx_abstract p')].map(p => ({ t: 'p' as const, children: inlines(p, rules) }));
  // arXiv's page header names the licence; a link inside the paper is the authors' text.
  const license = [...doc.querySelectorAll('a[href*="creativecommons.org"], a[href*="arxiv.org/licenses"]')]
    .find(link => !link.closest('article'))?.getAttribute('href') ?? undefined;
  return {
    source: 'arxiv',
    sourceUrl: url,
    license,
    lang: doc.documentElement.getAttribute('lang') || undefined,
    abstract,
    body,
    references,
    notes,
    conversionErrors: article.querySelectorAll('.ltx_ERROR').length,
  };
}

// Europe PMC: JATS XML.

const XLINK = 'http://www.w3.org/1999/xlink';

const instruction = (el: Element, target: string) => [...el.childNodes]
  .find((node): node is ProcessingInstruction => node.nodeType === Node.PROCESSING_INSTRUCTION_NODE && (node as ProcessingInstruction).target === target)
  ?.data.trim();

// Articles in PMC name their figure's copy on PMC's CDN in a processing
// instruction, in one of two forms; preprints are served from Europe PMC's
// file repository.
function figureUrl(graphic: Element, fullTextId: string): string | null {
  const blob = instruction(graphic, 'image-cloudpmc-urn')?.match(/^urn:cdn:(blobs\/.+)$/)?.[1]
    ?? (instruction(graphic, 'cloudpmc-bucket') === 'cdn' ? instruction(graphic, 'cloudpmc-path')?.match(/^blobs\/.+$/)?.[0] : undefined);
  if (blob) return safeExternalUrl(`https://cdn.ncbi.nlm.nih.gov/pmc/${blob}`) || null;
  const href = graphic.getAttributeNS(XLINK, 'href');
  if (!href || !fullTextId.startsWith('PPR')) return null;
  const fileName = /\.(jpe?g|png|gif)$/i.test(href) ? href : `${href}.jpg`;
  const mimeType = /\.png$/i.test(fileName) ? 'image/png' : /\.gif$/i.test(fileName) ? 'image/gif' : 'image/jpeg';
  return `https://europepmc.org/api/fulltextRepo?${new URLSearchParams({ pprId: fullTextId, type: 'FILE', fileName, mimeType })}`;
}

/**
 * The formula in a JATS `tex-math`, which often wraps it in a whole LaTeX
 * document; KaTeX needs only what sits between the math delimiters.
 */
export function jatsTex(source: string | null | undefined) {
  const body = clean(source).match(/\\begin\{document\}([\s\S]*)\\end\{document\}/)?.[1] ?? clean(source);
  return clean(body.replace(/^\s*(\$\$?|\\\[|\\\()/, '').replace(/(\$\$?|\\\]|\\\))\s*$/, '')) || undefined;
}

function jatsReference(ref: Element, index: number): Reference {
  const citation = ref.querySelector('element-citation, mixed-citation, citation') ?? ref;
  const field = (name: string) => clean(citation.getElementsByTagName(name)[0]?.textContent);
  const authors = [...citation.getElementsByTagName('person-group')]
    .filter(group => (group.getAttribute('person-group-type') ?? 'author') === 'author')
    .flatMap(group => [...group.getElementsByTagName('name'), ...group.getElementsByTagName('collab')])
    .map(name => (name.localName === 'collab'
      ? clean(name.textContent)
      : clean(`${name.getElementsByTagName('given-names')[0]?.textContent ?? ''} ${name.getElementsByTagName('surname')[0]?.textContent ?? ''}`)))
    .filter(Boolean);
  const pubId = (type: string) => clean([...citation.getElementsByTagName('pub-id')].find(id => id.getAttribute('pub-id-type') === type)?.textContent);
  const volume = field('volume');
  const issue = field('issue');
  const pages = [field('fpage'), field('lpage')].filter(Boolean).join('–');
  const venue = [field('source'), volume && `${volume}${issue ? `(${issue})` : ''}`, pages].filter(Boolean).join(', ');
  const title = field('article-title') || field('chapter-title') || undefined;
  // A citation given as one punctuated line still names its DOI and year in it.
  const line = clean(citation.textContent);
  const facts = citationFacts(line);
  return {
    id: ref.id,
    label: clean(ref.getElementsByTagName('label')[0]?.textContent).replace(/\.$/, '') || String(index + 1),
    authors,
    year: field('year') || facts.year,
    title,
    venue: venue || undefined,
    doi: pubId('doi') || facts.doi,
    pmid: pubId('pmid') || undefined,
    url: safeCatalogUrl(citation.getElementsByTagName('ext-link')[0]?.getAttributeNS(XLINK, 'href')) || undefined,
    // A mixed citation without the fields reads as the punctuated line it is.
    text: title ? '' : line,
  };
}

const BLOCKS_IN_PARAGRAPH = new Set(['disp-formula', 'list', 'fig', 'table-wrap']);

export function parseJats(xml: string, url: string, fullTextId: string): FullText | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const childNamed = (el: Element, name: string) => [...el.children].find(child => child.localName === name) ?? null;
  const text = (el: Element | null) => el?.textContent?.trim() || undefined;
  // Footnotes the text points at: the back matter's and a table's own. The
  // front matter's author notes are not part of the reading.
  const footnotes = [...doc.getElementsByTagName('fn')].filter(fn => fn.id && !fn.closest('front'));
  const noteLabels = new Map(footnotes.map((fn, index) => [fn.id, text(childNamed(fn, 'label')) ?? String(index + 1)]));
  const formulaTex = (formula: Element | null) => jatsTex(formula?.getElementsByTagName('tex-math')[0]?.textContent);
  const formulaImage = (formula: Element) => {
    const graphic = [...formula.getElementsByTagName('graphic'), ...formula.getElementsByTagName('inline-graphic')][0];
    return graphic ? figureUrl(graphic, fullTextId) ?? undefined : undefined;
  };
  const rules: InlineRules = {
    // `tex-math` and the graphics are other renderings of a formula already read as MathML.
    skip: el => ['fig', 'table-wrap', 'disp-formula', 'label', 'list', 'tex-math', 'graphic', 'inline-graphic'].includes(el.localName),
    ref: el => (el.localName === 'xref' ? el.getAttribute('rid')?.split(' ')[0] ?? null : null),
    // A link without a scheme ("www.who.int/…") stays text rather than resolving into Europe PMC.
    link: el => (['ext-link', 'uri'].includes(el.localName) ? safeCatalogUrl(el.getAttributeNS(XLINK, 'href') ?? el.textContent) || null : null),
    tex: math => formulaTex(math.closest('inline-formula, disp-formula')),
    replace: el => {
      // A footnote written where it is cited leaves its mark; it is read under Notes.
      if (el.localName === 'fn' && el.id) {
        return { t: 'sup', children: [{ t: 'ref', target: el.id, children: [{ t: 'text', text: noteLabels.get(el.id) ?? '*' }] }] };
      }
      // An inline formula with no MathML is shown from its TeX, or as the picture the journal supplied.
      if (el.localName !== 'inline-formula' || el.getElementsByTagNameNS(MATHML_NS, 'math').length) return null;
      const tex = formulaTex(el);
      if (tex) return { t: 'math', mathml: '', tex };
      const src = formulaImage(el);
      return src ? { t: 'formula-image', src } : null;
    },
  };
  const figureImages = (el: Element): FigureImage[] => [...el.getElementsByTagName('graphic')]
    .filter(graphic => graphic.getAttribute('content-type') !== 'thumb')
    .flatMap(graphic => {
      const src = figureUrl(graphic, fullTextId);
      return src ? [{ src, alt: text(childNamed(graphic, 'alt-text') ?? childNamed(el, 'alt-text')) }] : [];
    });

  let droppedFormulas = 0;
  const blocksOf = (el: Element, depth: number, out: Block[]) => {
    for (const child of el.children) {
      switch (child.localName) {
        case 'title':
          out.push({ t: 'heading', level: depth + 1, id: el.id || undefined, label: text(childNamed(el, 'label')), children: inlines(child, rules) });
          break;
        case 'sec':
          blocksOf(child, depth + 1, out);
          break;
        case 'p': {
          // JATS nests display formulas, lists and floats inside paragraphs.
          // Each keeps its place: the paragraph is split around it.
          const part = () => doc.createElementNS(child.namespaceURI, 'p');
          let run = part();
          const flush = () => {
            const content = inlines(run, rules);
            if (plainText(content).trim() || hasMath(content)) out.push({ t: 'p', children: content });
            run = part();
          };
          for (const node of child.childNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && BLOCKS_IN_PARAGRAPH.has((node as Element).localName)) {
              flush();
              const holder = part();
              holder.append(node.cloneNode(true));
              blocksOf(holder, depth, out);
            } else {
              run.append(node.cloneNode(true));
            }
          }
          flush();
          break;
        }
        case 'disp-formula': {
          const math = child.getElementsByTagNameNS(MATHML_NS, 'math')[0];
          const formula = { mathml: math ? mathml(math) : undefined, tex: formulaTex(child), image: formulaImage(child) };
          if (formula.mathml || formula.tex || formula.image) out.push({ t: 'equation', id: child.id || undefined, label: text(childNamed(child, 'label')), ...formula });
          else droppedFormulas += 1;
          break;
        }
        case 'list':
          out.push({
            t: 'list',
            ordered: child.getAttribute('list-type') === 'order',
            items: [...child.children].filter(item => item.localName === 'list-item').map(item => inlines(item, rules)),
          });
          break;
        case 'fig': {
          const caption = childNamed(child, 'caption');
          out.push({ t: 'figure', id: child.id || undefined, label: text(childNamed(child, 'label')), images: figureImages(child), caption: caption ? inlines(caption, rules) : [] });
          break;
        }
        case 'table-wrap': {
          const table = child.getElementsByTagName('table')[0];
          const caption = childNamed(child, 'caption');
          const common = { id: child.id || undefined, label: text(childNamed(child, 'label')), caption: caption ? inlines(caption, rules) : [] };
          if (table) out.push({ t: 'table', ...common, rows: rows(table, rules) });
          // Some tables arrive only as a picture of the table.
          else out.push({ t: 'figure', ...common, images: figureImages(child) });
          break;
        }
        default:
          break;
      }
    }
  };

  const meta = doc.querySelector('article-meta');
  const body: Block[] = [];
  const bodyEl = doc.querySelector('body');
  if (bodyEl) blocksOf(bodyEl, 0, body);
  // Europe PMC sometimes moves figures and tables out of the body, to a back
  // section ("display-objects") or a floats-group.
  doc.querySelectorAll('back > sec, floats-group').forEach(el => blocksOf(el, 1, body));
  // A formula with neither MathML, TeX nor a picture is not shown; the reader says so.
  droppedFormulas += [...doc.getElementsByTagName('inline-formula')]
    .filter(formula => !formula.getElementsByTagNameNS(MATHML_NS, 'math').length && !formulaTex(formula) && !formulaImage(formula)).length;
  const abstract: Block[] = [];
  const abstractEl = meta?.querySelector('abstract:not([abstract-type])') ?? meta?.querySelector('abstract');
  if (abstractEl) {
    // The reader titles the abstract itself.
    const withoutTitle = abstractEl.cloneNode(true) as Element;
    [...withoutTitle.children].filter(child => child.localName === 'title').forEach(title => title.remove());
    blocksOf(withoutTitle, 1, abstract);
  }
  const licenseEl = meta?.querySelector('license');
  const license = licenseEl?.getAttributeNS(XLINK, 'href') ?? licenseEl?.getAttribute('license-type') ?? undefined;
  return {
    source: 'europepmc',
    sourceUrl: url,
    license: license ?? undefined,
    lang: doc.documentElement.getAttribute('xml:lang') || undefined,
    abstract,
    body,
    references: [...doc.querySelectorAll('ref-list ref')].map(jatsReference),
    notes: footnotes.map(fn => ({ id: fn.id, label: noteLabels.get(fn.id)!, content: inlines(fn, rules) })),
    conversionErrors: droppedFormulas,
  };
}
